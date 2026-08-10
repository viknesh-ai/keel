# Security Policy

## Reporting a vulnerability

Please report privately through GitHub Security Advisories on this repository, or by email to
the address listed there. Do not open a public issue.

Include: what you found, how to reproduce it, the impact you believe it has, and any suggested
remediation. A working proof of concept helps but is not required.

## What to expect

- Acknowledgement within 3 working days.
- An initial assessment within 10 working days.
- Coordinated disclosure within 90 days, or sooner once a fix is released.
- Credit in the advisory unless you prefer otherwise.

## Scope

In scope: this repository's code, its default configuration, and the security properties
described in `docs/security/threat-model.md` — in particular identity verification, action
tokens, authorization decisions, tenant isolation, knowledge ACLs, egress control, and
webhook signing.

Out of scope: findings against a deployment's own misconfiguration, and issues in third-party
model providers.

## Known limitations

Prompt injection cannot be fully solved within current model architectures. Keel's design
reduces blast radius through capability restriction, provenance tracking, deterministic
policy enforcement outside the model, and egress allowlisting. It does not claim immunity,
and we would rather receive a report about a bypass than not hear about it. See
`docs/security/threat-model.md` §3 T1 for what is and is not guaranteed.

## Supported versions

Pre-alpha. No released versions yet; security fixes land on `main`.
