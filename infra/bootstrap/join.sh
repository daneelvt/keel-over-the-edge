#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Joins production's machine to the tailnet, once, by hand: the one step
# that is not a workflow run (infra/MANUAL-STEPS.md). Copied to the
# freshly installed machine and run as root, in two steps:
#
#   bash join.sh join            over the provider's first SSH login: installs
#                                Tailscale from its own apt repository, asks
#                                for the auth key, and joins as keel-prod-1,
#                                tagged tag:keel-prod, serving Tailscale SSH
#   bash join.sh close-openssh   then, from tailscale ssh root@keel-prod-1:
#                                stops OpenSSH for good, once this very
#                                session shows the new way in works
#
# From then on the machine workflow (the access role) keeps the same
# repository, key and settings, and removes OpenSSH's server.
set -euo pipefail

# Tailscale's apt repository for Ubuntu 26.04, and the key that signs it,
# pinned by its SHA-256 (pkgs.tailscale.com).
readonly keyring_url=https://pkgs.tailscale.com/stable/ubuntu/resolute.noarmor.gpg
readonly keyring_sha256=3e03dacf222698c60b8e2f990b809ca1b3e104de127767864284e6c228f1fb39
readonly keyring=/usr/share/keyrings/tailscale-archive-keyring.gpg
readonly sources=/etc/apt/sources.list.d/tailscale.sources
readonly machine=keel-prod-1
readonly tag=tag:keel-prod

die() {
	echo "join.sh: $*" >&2
	exit 1
}

need_root() {
	[[ $(id -u) -eq 0 ]] || die "run as root: it installs Tailscale and changes how the machine is reached"
}

# check_sha256 file want: fails unless file's SHA-256 is want.
check_sha256() {
	local got
	got=$(sha256sum "$1" | cut -d ' ' -f 1)
	[[ $got == "$2" ]] || die "$1's SHA-256 is $got, but $2 is pinned: not trusting it"
}

# from_tailscale address: whether an address is the tailnet's, Tailscale's
# CGNAT range 100.64.0.0/10 or its IPv6 range fd7a:115c:a1e0::/48.
from_tailscale() {
	local a=$1 o1 o2 rest
	if [[ $a == *:* ]]; then
		a=$(printf '%s' "$a" | tr 'A-F' 'a-f')
		[[ $a == fd7a:115c:a1e0:* ]]
		return
	fi
	IFS=. read -r o1 o2 rest <<<"$a"
	[[ $o1 == 100 && $o2 =~ ^[0-9]+$ ]] && ((o2 >= 64 && o2 <= 127))
}

install_tailscale() {
	# shellcheck source=/dev/null
	. /etc/os-release
	[[ ${VERSION_CODENAME:-} == resolute ]] || die "this is ${PRETTY_NAME:-not Ubuntu}; the machine runs Ubuntu 26.04 (resolute)"
	local tmp
	tmp=$(mktemp)
	curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --output "$tmp" "$keyring_url"
	check_sha256 "$tmp" "$keyring_sha256"
	install -m 0644 -o root -g root "$tmp" "$keyring"
	rm -f "$tmp"
	# The same file the access role writes.
	cat >"$sources" <<-'SOURCES'
		# Tailscale's packages, signed by its key alone.
		Types: deb
		URIs: https://pkgs.tailscale.com/stable/ubuntu
		Suites: resolute
		Components: main
		Signed-By: /usr/share/keyrings/tailscale-archive-keyring.gpg
	SOURCES
	chmod 0644 "$sources"
	apt-get update
	apt-get install --yes --no-install-recommends tailscale
	systemctl enable --now tailscaled
}

join() {
	need_root
	install_tailscale

	# The key never reaches the screen, the shell's history or the
	# command line: it is read here and handed to tailscale in a file.
	local key keyfile
	read -rsp "The auth key, from Tailscale's admin page (tskey-auth-…): " key
	echo
	[[ $key == tskey-auth-* ]] || die "that is not an auth key"
	keyfile=$(mktemp)
	chmod 0600 "$keyfile"
	printf '%s' "$key" >"$keyfile"
	unset key
	if ! tailscale up --auth-key="file:$keyfile" --ssh --accept-dns=false \
		--hostname="$machine" --advertise-tags="$tag" --timeout=2m; then
		rm -f "$keyfile"
		die "tailscale up failed: make a new key (one-off, pre-approved, tagged $tag) and run join again"
	fi
	rm -f "$keyfile"

	local ip
	for _ in $(seq 60); do
		if ip=$(tailscale ip -4 2>/dev/null) && [[ -n $ip ]]; then
			echo "join.sh: $machine is on the tailnet at $ip, tagged $tag, serving Tailscale SSH."
			echo "join.sh: now, from your computer: tailscale ssh root@$machine"
			echo "join.sh: and there: bash join.sh close-openssh"
			return
		fi
		sleep 1
	done
	die "the machine did not come up on the tailnet within a minute: tailscale status says why"
}

close_openssh() {
	need_root
	# SSH_CONNECTION is "client port server port"; Tailscale SSH sets it
	# as OpenSSH does.
	local client=${SSH_CONNECTION%% *}
	if [[ -z ${SSH_CONNECTION:-} ]] || ! from_tailscale "$client"; then
		die "this session does not come over the tailnet (${SSH_CONNECTION:-no SSH_CONNECTION}): run it from tailscale ssh root@$machine, so the new way in is proven before the old one goes"
	fi
	systemctl disable --now ssh.socket ssh.service
	systemctl mask ssh.socket ssh.service
	local listening
	listening=$(ss --listening --tcp --numeric --no-header --processes 'sport = :22' | grep -v '"tailscaled"' || true)
	[[ -z $listening ]] || die "something still listens on port 22: $listening"
	echo "join.sh: OpenSSH is stopped and masked; only Tailscale SSH reaches the machine now."
}

usage() {
	echo "usage: bash join.sh join | close-openssh" >&2
	exit 2
}

# Run, unless sourced (by the tests).
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
	case ${1:-} in
	join) join ;;
	close-openssh) close_openssh ;;
	*) usage ;;
	esac
fi
