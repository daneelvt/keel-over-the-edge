# Contributing

Thank you for wanting to help with Keel Over the Edge. Bug reports, ideas and
discussion are welcome in [issues](https://github.com/daneelvt/keel-over-the-edge/issues),
and pull requests are welcome too, under the contributor agreement below.

## What is welcome

- Bug fixes, with a test that fails without the fix.
- Tests, and small improvements to what is already there.
- Corrections to the documentation.

**A larger change starts as an issue**, so that we can agree on it before you
spend your time: a new feature, a change to how the game plays or to the
boats' and the world's numbers (the catalog), a new dependency, or anything
touching the protocol between the client and the server.

## What is not taken

- **Art, sound, music and writing** for the game, and its name. The code is
  open; the game's look, sound and words are the owner's (see "Name and art"
  below). Ideas for them are welcome in an issue.
- Changes nobody asked for that churn the code: formatting sweeps, renames,
  generated refactors, dependency updates (Renovate opens those).
- A change you cannot explain.

The owner closes such pull requests without review, and says why once, here.

## Building and testing

[docs/development.md](docs/development.md) has everything: what to install,
the one command that runs the game locally, and the checks a pull request
must pass ("Checks"). Run them before you open one.

## The contributor agreement

Before a pull request can be merged, everyone who wrote it signs the
[Keel Over the Edge Contributor Agreement](legal/agreement-1.md), once. A
check named `pr-agreement` on your pull request says whether everyone has; if
not, a comment links the signing page. You sign in with GitHub there, give
your name, tick three boxes and sign: under a minute, and the check turns
green by itself.

**In plain words** (this is not the agreement, and changes nothing in it):

- **You keep your copyright.** What you write stays yours. You can use it,
  publish it and license it to anyone else, as you could before.
- **You give the game's owner a licence to it**, for good, worldwide and free
  of charge: to use, change and distribute your contribution as part of the
  game, and to license it to others under any terms, including a commercial
  or closed-source edition of the game.
- **The owner promises it stays open.** Whatever else the owner does with
  your contribution, it also stays available under the game's open licence,
  the GNU Affero General Public License, version 3 only. The game's history
  names you as its author.
- **Why:** the game is built by one person. Keeping a commercial edition
  possible is how it can pay for itself, and that needs the right to license
  every part of the code, contributions included. Without this agreement,
  every contributor would have to be found and asked first.
- **What is covered:** code, tests, documentation and configuration. The
  game's art, sound, music and writing, and its name, stay the owner's and
  are not taken under this agreement.
- **What you confirm:** the contribution is yours to give (your employer, if
  you have one, has no claim on it, or agrees); you have said where an AI
  tool helped, and you understand what it wrote; anything copied from
  elsewhere is marked, and under a permissive licence; you are 18 or older,
  or sign together with a parent or guardian.
- **You sign once**, by signing in with GitHub on the game's site. A new
  version of the agreement, if there ever is one, is signed before your next
  contribution.

**Who must sign.** The author of each commit, its committer, and every person
named in a `Co-authored-by:` trailer. Make sure each commit's e-mail is one
your GitHub account knows (GitHub's settings, "Emails"), or the check cannot
tell who wrote it. Bots that keep the dependencies, and AI tools named in a
trailer, need not sign: the person who used the tool signs for what they
submit.

**Under 18?** Choose "I am under 18" on the signing page: it tells you how
your parent or guardian agrees with you.

**Your signature** is kept privately by the owner, and never published. The
[privacy notice](legal/privacy.md) says what is kept, why and for how long.

## AI-assisted contributions

Welcome, on three conditions, which the agreement holds you to:

- **Say so.** Name the tool in a trailer on the commit, `Assisted-by: <tool>`
  or `Co-authored-by: <tool> <its address>`, or in the pull request's
  description.
- **Own it.** You have read and understood every line, you can explain it
  in review, and you answer for it as for your own.
- **Nothing from elsewhere.** No code from other projects comes in through
  the tool.

The owner builds the game the same way, with an AI assistant named on every
commit it helped with.

## Review

The owner reviews pull requests in their own time, and may ask for changes,
make them, or decline the change; a pull request is a proposal, and there is
no promise of a merge. Leave "Allow edits by maintainers" on: `main` must be
up to date before a merge, and that lets the owner bring your branch up to
date.

A pull request is squash-merged, and its description becomes the commit's
message: keep it short, say what changes and why. Every workflow run on a
pull request from a fork waits for the owner's approval, on every push.

## Name and art

The code is licensed under the AGPL. The name "Keel Over the Edge", its
logo, and the game's art, sound, music and writing are not: all rights in
them are reserved (the AGPL's section 7(e) allows exactly this). A fork is
welcome to use the code under the AGPL, but must use a different name and
its own art.

## Conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Security

Please report a vulnerability privately, as [SECURITY.md](SECURITY.md) says,
never in an issue or a pull request.
