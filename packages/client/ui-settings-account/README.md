---
description: "Retired client registration: the Desktop account login surfaces are gone; the component tree and locale dictionaries stay compiled for their specs."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-account

English | [中文](README.zh.md)

## Summary

The client entry registers nothing: the Desktop account login surfaces — the account settings section, the sidebar account menu, the account sign-in onboarding row, the account quota notice, and the native Platform page host — are retired, and every owning shell keeps its own non-account fallback. The package tree stays compiled: components and locale dictionaries remain for their specs, and the entry keeps the `settings.account` locale-namespace typing those files use.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)

<a id="use-this-package"></a>
## Use this package

Roster rows that still list this package mount it unchanged, but the client contributes no seats and no account Remote traffic in any renderer. Plain Web clients never rendered these seats; the Desktop profile additionally disables the row outright through the launcher-owned account-sweep overlay, so no account login surface exists there.

<a id="model-experience"></a>
## Model Experience

None, as account credentials affect HTTP authentication and never enter model prompts, Session logs, or tool results.

#### KV Cache effect

No model request prefix changes.

<a id="dev-note"></a>
### Dev Note

The [desktop login decision](../../../.agents/notes/implemented/architecture/2026-09-14-deepseek-account-login.md) records the original cancellation and storage ownership. The Desktop retirement is applied by the launcher-owned account-sweep overlay (`apps/desktop-host/src/index.ts`), whose Web e2e mirror is pinned byte-identical by `apps/desktop-host/tests/account-sweep.spec.ts`.
