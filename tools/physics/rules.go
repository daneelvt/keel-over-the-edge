// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// allowedImports are all the physics package may import.
var allowedImports = []string{"math", "math/bits"}

// wasmImports are all the module's entry point may import; it is not held to
// the package's other rules.
var wasmImports = []string{"runtime", "unsafe", "github.com/daneelvt/keel-over-the-edge/internal/physics"}

// exactMath are the functions of package math the physics package may call:
// operations IEEE 754 rounds exactly, and functions that only move bits.
var exactMath = []string{
	"Sqrt", "Floor", "Ceil", "Trunc", "Abs", "Copysign",
	"Float64bits", "Float64frombits", "Signbit", "IsNaN", "IsInf", "Inf", "NaN",
}

// banned builtins: they allocate, or stop the step.
var bannedBuiltins = []string{"append", "make", "new", "panic", "recover", "print", "println"}

// float64ToInt is the one function allowed to convert floats to integers.
const float64ToInt = "toInt32"

// checkRules checks the Go files of the package in dir (tests aside). For a
// package held only to an import list, imports is that list and the other
// rules apply only when it is allowedImports.
func checkRules(dir string, imports []string) ([]string, error) {
	fset := token.NewFileSet()
	names, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil {
		return nil, err
	}
	var files []*ast.File
	for _, name := range names {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, name, nil, parser.ParseComments|parser.SkipObjectResolution)
		if err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("no Go files in %s", dir)
	}

	c := &checker{fset: fset}
	for _, f := range files {
		for _, imp := range f.Imports {
			path := strings.Trim(imp.Path.Value, `"`)
			if !slices.Contains(imports, path) {
				c.report(imp.Pos(), "imports %s; the package may import only %s", path, strings.Join(imports, ", "))
			}
		}
	}
	if !slices.Equal(imports, allowedImports) {
		return c.problems, nil
	}

	c.info = &types.Info{
		Types: map[ast.Expr]types.TypeAndValue{},
		Uses:  map[*ast.Ident]types.Object{},
	}
	conf := types.Config{Importer: importer.ForCompiler(fset, "source", nil)}
	if _, err := conf.Check(files[0].Name.Name, fset, files, c.info); err != nil {
		return nil, err
	}
	for _, f := range files {
		for _, d := range f.Decls {
			fn, _ := d.(*ast.FuncDecl)
			c.fn = ""
			if fn != nil {
				c.fn = fn.Name.Name
			}
			ast.Inspect(d, c.visit)
		}
	}
	return c.problems, nil
}

type checker struct {
	fset     *token.FileSet
	info     *types.Info
	fn       string // the function being walked
	problems []string
}

func (c *checker) report(pos token.Pos, format string, args ...any) {
	p := c.fset.Position(pos)
	rel, err := filepath.Rel(mustGetwd(), p.Filename)
	if err != nil {
		rel = p.Filename
	}
	c.problems = append(c.problems, fmt.Sprintf("%s:%d:%d: %s", filepath.ToSlash(rel), p.Line, p.Column, fmt.Sprintf(format, args...)))
}

func (c *checker) visit(n ast.Node) bool {
	switch n := n.(type) {
	case *ast.GoStmt:
		c.report(n.Pos(), "a goroutine; the step runs on one thread")
	case *ast.DeferStmt:
		c.report(n.Pos(), "defer; it may allocate")
	case *ast.SelectStmt, *ast.SendStmt, *ast.ChanType:
		c.report(n.Pos(), "a channel; the step runs on one thread")
	case *ast.UnaryExpr:
		if n.Op == token.ARROW {
			c.report(n.Pos(), "a channel; the step runs on one thread")
		}
	case *ast.MapType:
		c.report(n.Pos(), "a map; its order and its allocations are not fixed")
	case *ast.FuncLit:
		c.report(n.Pos(), "a function literal; a closure may allocate")
	case *ast.SelectorExpr:
		c.checkMath(n)
	case *ast.CallExpr:
		c.checkCall(n)
	case *ast.BinaryExpr:
		if n.Op == token.ADD || n.Op == token.SUB {
			c.checkFusable(n.X, n.Y)
		}
	case *ast.AssignStmt:
		if (n.Tok == token.ADD_ASSIGN || n.Tok == token.SUB_ASSIGN) && len(n.Rhs) == 1 {
			c.checkFusable(n.Lhs[0], n.Rhs[0])
		}
	}
	return true
}

// checkMath allows from package math only constants and exactMath.
func (c *checker) checkMath(sel *ast.SelectorExpr) {
	x, ok := sel.X.(*ast.Ident)
	if !ok {
		return
	}
	pkg, ok := c.info.Uses[x].(*types.PkgName)
	if !ok || pkg.Imported().Path() != "math" {
		return
	}
	switch obj := c.info.Uses[sel.Sel].(type) {
	case *types.Const:
		return
	case *types.Func:
		if slices.Contains(exactMath, obj.Name()) {
			return
		}
		c.report(sel.Pos(), "math.%s does not give the same bits on every machine; use the package's own function or one of math.%s",
			obj.Name(), strings.Join(exactMath, ", math."))
	default:
		c.report(sel.Pos(), "math.%s is not allowed", sel.Sel.Name)
	}
}

func (c *checker) checkCall(call *ast.CallExpr) {
	if id, ok := ast.Unparen(call.Fun).(*ast.Ident); ok {
		if b, ok := c.info.Uses[id].(*types.Builtin); ok && slices.Contains(bannedBuiltins, b.Name()) {
			c.report(call.Pos(), "%s; a step must not allocate or stop", b.Name())
		}
	}
	// A conversion from a float to an integer type.
	tv, ok := c.info.Types[call.Fun]
	if !ok || !tv.IsType() || len(call.Args) != 1 || c.fn == float64ToInt {
		return
	}
	to, ok := tv.Type.Underlying().(*types.Basic)
	if !ok || to.Info()&types.IsInteger == 0 {
		return
	}
	arg := c.info.Types[call.Args[0]]
	if from, ok := arg.Type.Underlying().(*types.Basic); ok && from.Info()&types.IsFloat != 0 && arg.Value == nil {
		c.report(call.Pos(), "converts a float to %s; out-of-range conversions differ between machines, so use %s", to.Name(), float64ToInt)
	}
}

// checkFusable reports a product added to or subtracted from without an
// explicit conversion, which Go may fuse into one instruction.
func (c *checker) checkFusable(operands ...ast.Expr) {
	for _, op := range operands {
		m, ok := ast.Unparen(op).(*ast.BinaryExpr)
		if !ok || m.Op != token.MUL || !c.isRuntimeFloat(m) {
			continue
		}
		c.report(m.Pos(), "a product added to or subtracted from may be fused into one instruction on some machines; write float64(…)")
	}
}

// isRuntimeFloat reports whether e is a float computed at run time, not a
// constant the compiler folds.
func (c *checker) isRuntimeFloat(e ast.Expr) bool {
	tv, ok := c.info.Types[e]
	if !ok || tv.Value != nil {
		return false
	}
	b, ok := tv.Type.Underlying().(*types.Basic)
	return ok && b.Info()&types.IsFloat != 0
}

func mustGetwd() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return wd
}
