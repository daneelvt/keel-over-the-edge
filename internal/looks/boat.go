// SPDX-License-Identifier: AGPL-3.0-only

package looks

import (
	"fmt"
	"strconv"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
)

// A boat's look: the paint on its hull and the cloth of its sails, places
// in the catalog's lists, and its sail number. Its name is player text,
// sent apart from the code. The boat look code is one number: the paint in
// bits 0–3, the cloth in bits 4–7 and the number in bits 8–21.

// BoatLook is a boat's paint, cloth and sail number.
type BoatLook struct {
	Paint, Cloth int
	Number       int
}

// MaxBoatCode is the largest boat look code: 22 bits.
const MaxBoatCode = 1<<22 - 1

// Code is the boat look code of l. A value out of its field is masked to
// it, so check l with Boats.Valid first.
func (l BoatLook) Code() uint32 {
	return uint32(l.Paint&15) | uint32(l.Cloth&15)<<4 | uint32(l.Number&(1<<14-1))<<8
}

// BoatOf is the boat look a code names, unchecked.
func BoatOf(code uint32) BoatLook {
	return BoatLook{Paint: int(code & 15), Cloth: int(code >> 4 & 15), Number: int(code >> 8 & (1<<14 - 1))}
}

// Boats is the catalog's boat looks, as they are checked and said.
type Boats struct {
	looks catalog.BoatLooks
	kinds []catalog.Boat
}

// NewBoats is the book of the catalog's boat looks.
func NewBoats(cat *catalog.Catalog) *Boats {
	return &Boats{looks: cat.BoatLooks, kinds: cat.Boats}
}

// MaxNumber is the highest sail number.
func (b *Boats) MaxNumber() int { return b.looks.Numbers }

// Valid reports whether l is of the catalog's paints and cloths, with a
// sail number in its range.
func (b *Boats) Valid(l BoatLook) bool {
	return l.Paint >= 0 && l.Paint < len(b.looks.Paints) && l.Cloth >= 0 && l.Cloth < len(b.looks.Cloths) &&
		l.Number >= 1 && l.Number <= b.looks.Numbers
}

// Paint is the place of the paint with an id among the catalog's, or −1.
func (b *Boats) Paint(id string) int { return find(b.looks.Paints, id, paintID) }

// Cloth is the place of the cloth with an id among the catalog's, or −1.
func (b *Boats) Cloth(id string) int { return find(b.looks.Cloths, id, clothID) }

func paintID(p *catalog.BoatPaint) catalog.ID { return p.ID }
func clothID(c *catalog.BoatCloth) catalog.ID { return c.ID }

// PaintID and ClothID are the ids of a paint and a cloth by their places;
// "" for none.
func (b *Boats) PaintID(i int) string {
	if i < 0 || i >= len(b.looks.Paints) {
		return ""
	}
	return string(b.looks.Paints[i].ID)
}

func (b *Boats) ClothID(i int) string {
	if i < 0 || i >= len(b.looks.Cloths) {
		return ""
	}
	return string(b.looks.Cloths[i].ID)
}

// PaintName and ClothName are their names as the player reads them.
func (b *Boats) PaintName(i int) string {
	if i < 0 || i >= len(b.looks.Paints) {
		return ""
	}
	return b.looks.Paints[i].Name
}

func (b *Boats) ClothName(i int) string {
	if i < 0 || i >= len(b.looks.Cloths) {
		return ""
	}
	return b.looks.Cloths[i].Name
}

// Paints and Cloths are the choices a boat's look is made from, as the
// chooser and the machine sailors' tools offer them.
func (b *Boats) Paints() []Choice {
	out := make([]Choice, len(b.looks.Paints))
	for i, p := range b.looks.Paints {
		out[i] = Choice{ID: string(p.ID), Name: p.Name, Colour: p.Colour}
	}
	return out
}

func (b *Boats) Cloths() []Choice {
	out := make([]Choice, len(b.looks.Cloths))
	for i, c := range b.looks.Cloths {
		out[i] = Choice{ID: string(c.ID), Name: c.Name, Colour: c.Colour}
	}
	return out
}

// KindName is the name of a kind of boat by its place in the catalog, ""
// for none.
func (b *Boats) KindName(kind int) string {
	if kind < 0 || kind >= len(b.kinds) {
		return ""
	}
	return b.kinds[kind].Name
}

// Named is a boat as it is named to others: its kind, its name in «»
// (player text) if it has one, and its sail number: "Keelboat «Saltpeter»
// 311"; "Jolly boat 12".
func Named(kind, name string, number int) string {
	s := kind
	if name != "" {
		s += " «" + name + "»"
	}
	if number > 0 {
		s += " " + strconv.Itoa(number)
	}
	return s
}

// Words are a boat's look in words: "red ochre, tanbark sails".
func (b *Boats) Words(l BoatLook) string {
	return fmt.Sprintf("%s, %s sails", b.PaintName(l.Paint), b.ClothName(l.Cloth))
}
