# extensions/

Optional, separately deployed software that sits next to MarginPulse. **Nothing here is imported by the
frontend or the Worker, and nothing here runs unless you deploy it yourself.**

| Folder | What | Status |
|---|---|---|
| [`whatsapp-gateway/`](whatsapp-gateway/README.md) | Free WhatsApp fallback (Baileys sidecar) that forwards invoices/statements into the app | Built and tested here; **opt-in**, needs an always-on machine and a phone to pair |
| `erpnext/` | [ERPNext](https://github.com/frappe/erpnext) (Frappe) ERP — **unmodified upstream**, pinned `v16.55.0` (`8e10a34`) | **Parked.** Not installed, not wired, not tested with MarginPulse |

## ERPNext: parked, unchanged, ready to connect later

`extensions/erpnext` is a **git submodule** pointing at the upstream repository at a fixed release. We did not copy
or edit any of its files — that keeps the ~190 MB of upstream code out of this repo's history, makes upgrades a
one-line change, and keeps its GPL-3.0 licence cleanly separate from MarginPulse's own code.

```bash
# get it (only when you want it)
git clone --recurse-submodules https://github.com/700imran/prod-marginpulse-front-back
#   or, in an existing clone:
git submodule update --init --depth 1 extensions/erpnext

# upgrade later (review upstream release notes first)
git -C extensions/erpnext fetch --depth 1 origin tag <new-tag> && git -C extensions/erpnext checkout <new-tag>
git add extensions/erpnext && git commit -m "Bump ERPNext to <new-tag>"
```

If a hosting provider's build clones submodules and you don't want that cost on every deploy, switch submodule
fetching off in that provider's settings — nothing in the app build needs this folder.

### How to connect it when you are ready (not done yet)

1. **Run it as its own service**, not inside the Worker or the React bundle. ERPNext needs MariaDB, Redis and Python/Node
   workers, so the supported route is upstream's [`frappe_docker`](https://github.com/frappe/frappe_docker) on a VM
   (or Frappe Cloud). This folder is the source reference; production installs normally pull the images/`bench` instead.
2. **Integrate over its REST API only** (`/api/resource/<DocType>`, authenticated with an API key + secret generated for a
   dedicated "MarginPulse" user with the minimum roles). Keeping the link at the HTTP boundary means MarginPulse's code
   never links against GPL code.
3. **Suggested first integration** (a small Worker route behind a feature flag, tenant-scoped like the rest of the API):
   push *reconciled* documents as Purchase Invoices / Journal Entries, keyed by `document_id` so retries are idempotent.
   Reuse the patterns already in this repo: signed requests, `fetchExternal` timeouts, queue retry with backoff, and
   `emit(...)` metrics + alerts so the sync is as observable as the rest.
4. **Branding** (the "MarginPulse ERP" look) should be done with Frappe's own mechanisms — Website/System Settings, a
   small custom Frappe app, or a theme — **not** by editing upstream files, so upgrades stay a version bump. Read
   `extensions/erpnext/TRADEMARK_POLICY.md` before using the ERPNext/Frappe names or logos in anything public.
5. Keep per-tenant data isolation in mind: ERPNext is "one site per company". Plan one site (or one company) per MarginPulse
   tenant, and never let one tenant's credentials reach another's site.

No part of this has been installed or exercised; treat the steps above as a plan, not a tested procedure.

### Licence note

ERPNext is GPL-3.0 (`extensions/erpnext/license.txt`). Using it as a separately running service reached over HTTP is the
usual way to keep that separate from proprietary code, but if you plan to distribute a modified ERPNext, or have any
doubt, ask a lawyer — this is not legal advice.
