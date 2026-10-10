// SPDX-License-Identifier: AGPL-3.0-only

package pinned

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
)

// File is this file's sister, where the pins are written, from the
// repository's root.
const File = "tools/internal/pinned/pinned.go"

var (
	tailscaleVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
	sha256Hex        = regexp.MustCompile(`^[0-9a-f]{64}$`)
	// tailscalePin is a line of byHand.
	tailscalePin = regexp.MustCompile(`\{tailscaleSite, "(linux-[a-z0-9]+)", "[0-9.]+", "[0-9a-f]{64}"\}`)
)

// RepinTailscale pins Tailscale's static client at version in file
// (pinned.go), for each platform pinned now, with the SHA-256 Tailscale
// publishes beside each file.
func RepinTailscale(ctx context.Context, file, version string, log io.Writer) error {
	if !tailscaleVersion.MatchString(version) {
		return fmt.Errorf("%q is not a version of Tailscale, as 1.104.1", version)
	}
	src, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	sums := map[string]string{}
	for _, m := range tailscalePin.FindAllStringSubmatch(string(src), -1) {
		platform := m[1]
		goarch := strings.TrimPrefix(platform, "linux-")
		u := site + tailscaleSite + "/" + Tailscale.asset(version, "linux", goarch) + ".sha256"
		sum, err := fetchText(ctx, u)
		if err != nil {
			return err
		}
		if !sha256Hex.MatchString(sum) {
			return fmt.Errorf("%s holds no SHA-256: %q", u, sum)
		}
		sums[platform] = sum
		fmt.Fprintf(log, "pinned: tailscale %s for %s: %s\n", version, platform, sum)
	}
	if len(sums) == 0 {
		return fmt.Errorf("%s pins no Tailscale", file)
	}
	out := tailscalePin.ReplaceAllStringFunc(string(src), func(line string) string {
		platform := tailscalePin.FindStringSubmatch(line)[1]
		return fmt.Sprintf("{tailscaleSite, %q, %q, %q}", platform, version, sums[platform])
	})
	return os.WriteFile(file, []byte(out), 0o644)
}

// fetchText is a short text file's content, trimmed.
func fetchText(ctx context.Context, u string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s answered %s", u, res.Status)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 4096))
	return strings.TrimSpace(string(b)), err
}
