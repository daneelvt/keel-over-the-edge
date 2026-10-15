// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/names"
)

func TestNamesAndWorldRejects(t *testing.T) {
	islands := namesDir + "/" + names.IslandsFile
	specifics := namesDir + "/" + names.SpecificsFile
	avoid := namesDir + "/" + names.AvoidFile
	cases := []struct {
		name  string
		files map[string]string
		want  string
	}{
		{
			name:  "a name the avoid list bans",
			files: map[string]string{avoid: realFile(avoid) + "\nBooby Cay\n"},
			want:  "Booby Cay): the avoid list bans it",
		},
		{
			name:  "a name with a banned word",
			files: map[string]string{avoid: realFile(avoid) + "\nword:Booby\n"},
			want:  "Booby Cay): the avoid list bans it",
		},
		{
			name:  "the same name with another generic",
			files: map[string]string{avoid: realFile(avoid) + "\nBooby Island\n"},
			want:  "Booby Cay): the avoid list bans it",
		},
		{
			name:  "a specific whose combination the avoid list bans",
			files: map[string]string{avoid: realFile(avoid) + "\nGull Holm\n"},
			want:  `(Gull): the avoid list bans "Gull Holm"`,
		},
		{
			name:  "a name twice",
			files: map[string]string{islands: realFile(islands) + "Booby Cay,islet,sandy,,any,plain,again\n"},
			want:  `"Booby Cay" is also`,
		},
		{
			name:  "an unknown tag",
			files: map[string]string{islands: strings.Replace(realFile(islands), "Booby Cay,islet;small,sandy;tropical,birds,any,plain", "Booby Cay,islet;small,sandy;tropical,birds,any,jolly", 1)},
			want:  `tone "jolly" is not one of`,
		},
		{
			name:  "a size outside the classes",
			files: map[string]string{islands: strings.Replace(realFile(islands), "Booby Cay,islet;small,", "Booby Cay,islet;huge,", 1)},
			want:  `size "huge" is not one of`,
		},
		{
			name:  "a need no feature is",
			files: map[string]string{islands: strings.Replace(realFile(islands), "Booby Cay,islet;small,sandy;tropical,birds,", "Booby Cay,islet;small,sandy;tropical,bats,", 1)},
			want:  `needs "bats" is not one of`,
		},
		{
			name:  "a specific taking a class no generic has",
			files: map[string]string{specifics: strings.Replace(realFile(specifics), "Gull,cay;holm;isle;rock,", "Gull,cay;holm;isle;reef,", 1)},
			want:  `takes "reef" is not one of`,
		},
		{
			name:  "a range upside down",
			files: map[string]string{worldPath: strings.Replace(realFile(worldPath), "across: [500, 600] # m", "across: [600, 500] # m", 1)},
			want:  "world.mainPort.across: [600 500] runs from high to low",
		},
		{
			name:  "a biome naming no surface",
			files: map[string]string{worldPath: strings.Replace(realFile(worldPath), "surfaces: { beach: sand, low: dune-grass", "surfaces: { beach: shingle, low: dune-grass", 1)},
			want:  `"shingle" is not a surface`,
		},
		{
			name:  "size classes out of order",
			files: map[string]string{worldPath: strings.Replace(realFile(worldPath), "{ class: islet, below: 100 }", "{ class: islet, below: 10 }", 1)},
			want:  "world.sizes[1]: below 10 is not above",
		},
		{
			name: "a biome's id in code",
			files: map[string]string{
				"internal/x/x.go": "package x\n\nvar b = \"volcanic\"\n",
			},
			want: `internal/x/x.go: "volcanic"`,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			c.files["shared/catalog/boats.yaml"] = validBoats
			err := checkAll(fixture(t, c.files))
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("error %v does not mention %q", err, c.want)
			}
		})
	}
}

func TestNamesStayOutOfTheClient(t *testing.T) {
	client, err := os.ReadFile(filepath.Join("..", "..", tsJSONPath))
	if err != nil {
		t.Fatal(err)
	}
	server, err := os.ReadFile(filepath.Join("..", "..", namesGenPath))
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Booby Cay", "Hen and Chickens", "Plunder"} {
		if strings.Contains(string(client), name) {
			t.Errorf("the client's catalog holds %q", name)
		}
		if !strings.Contains(string(server), name) {
			t.Errorf("the server's names lack %q", name)
		}
	}
}
