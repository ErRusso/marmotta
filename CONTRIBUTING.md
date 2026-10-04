# Marmotta is an OPEN Open Source Project

## What?

Individuals making significant and valuable contributions are given
commit-access to the project to contribute as they see fit. This project is more
like an open wiki than a standard guarded open source project.

See our [informal contributing guide](./docs/contributing.md) for more
details on contributing to this project.

### I want to be a collaborator!

If you think you meet the above criteria and we have not invited you yet, we are
sorry! Feel free to reach out to a [Lead
Maintainer](https://github.com/napi-bindings/marmotta#team) privately with a few links
to your valuable contributions. Read the [GOVERNANCE](GOVERNANCE.md) to get more
information.

## Rules

There are a few basic ground rules for contributors:

1. **No `--force` pushes** on `main` or modifying the Git history in any way
   after a PR has been merged.
1. **Non-main branches** ought to be used for ongoing work.
1. **External API changes and significant modifications** ought to be subject to
   an **internal pull request** to solicit feedback from other contributors.
1. Internal pull requests to solicit feedback are *encouraged* for any other
   non-trivial contribution but are left to the discretion of the contributor.
1. Contributors should attempt to adhere to the prevailing code style.
1. At least two contributors, or one core member, must approve pull requests
   before merging.
1. All integrated CI services must be green before a pull request can be merged.
1. A lead maintainer must merge SemVer-major changes in this repository.
1. If it is not possible to reach a consensus in a pull request, the decision
   is left to the lead maintainer's team.
1. Pure-AI contributions with no human in the loop are not welcome. Pull
requests ***MUST*** be opened by a human. Pull requests opened by bots not
managed by the napi-bindings organization will result in the bot being banned
from the organization.

## Releases

Declaring formal releases remains the prerogative of the lead maintainers. Do
not bump version numbers in pull requests.

## Changes to this arrangement

This is an experiment and feedback is welcome! This document may also be subject
to pull requests or changes by contributors where you believe you have something
valuable to add or change.

# napi-bindings Organization Structure

The napi-bindings structure is detailed in the [GOVERNANCE](GOVERNANCE.md) document.

### Onboarding Collaborators

Welcome to the team! We are happy to have you. Before you start, please complete
the following tasks:
1. Set up 2 factor authentication for GitHub and NPM
    - [GitHub
    2FA](https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa)
    - [NPM 2FA](https://docs.npmjs.com/about-two-factor-authentication/)
2. Open a pull request to
   [`napi-bindings/marmotta:HEAD`](https://github.com/napi-bindings/marmotta/pulls) that adds
   your name, username, and email to the team in the [README.md](./README.md) and 
   [package.json](./package.json) files. The member lists are sorted alphabetically by last
   name; make sure to add your name in the proper order..
3. Optionally, the person can be added as an Open Collective member
   by the lead team.

### Offboarding Collaborators

We are thankful to you and we are really glad to have worked with you. We'd be
really happy to see you here again if you want to come back, but for now the
person that did the onboarding must:
1. Ask the collaborator if they want to stay or not.
1. If the collaborator can't work with us anymore, they should:
  1. Open a pull request to
     [`napi-bindings/marmotta:HEAD`](https://github.com/napi-bindings/marmotta/pulls) and move
     themselves to the *Past Collaborators* section.

-----------------------------------------

<a id="developers-certificate-of-origin"></a>
## Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

* (a) The contribution was created in whole or in part by me and I have the
  right to submit it under the open source license indicated in the file; or

* (b) The contribution is based upon previous work that, to the best of my
  knowledge, is covered under an appropriate open source license and I have the
  right under that license to submit that work with modifications, whether
  created in whole or in part by me, under the same open source license (unless
  I am permitted to submit under a different license), as indicated in the file;
  or

* (c) The contribution was provided directly to me by some other person who
  certified (a), (b) or (c) and I have not modified it.

* (d) I understand and agree that this project and the contribution are public
  and that a record of the contribution (including all personal information I
  submit with it, including my sign-off) is maintained indefinitely and may be
  redistributed consistent with this project or the open source license(s)
  involved.
