# Form Quickfill

A Chrome side panel for hand-sending cold outreach through agencies' website contact forms,
with a Notion database as the lead queue and the log. Built for working through a partner
directory (set up here for the **Shopify Partners Directory**) one agency at a time:

1. **Next lead** opens the next agency's contact page and fills the form: your name, email,
   company and a personalised message ("Hey Anna," when the founder's name is known).
2. Fields the rules can't place (dropdowns, "how many years…", "how did you hear about us")
   go to **agy**, which answers only from your facts file and leaves anything it doesn't
   know (phone, rates, budgets) empty.
3. You check the form, solve any CAPTCHA and click **Send** yourself. The extension
   **never submits**. It spots the thank-you message and marks the lead Contacted in Notion.
4. **Open email instead** opens a Gmail compose tab with the same message, for sites with
   no usable form. **Skip** (with a reason) drops a lead for good. **Remember this** turns
   an answer you typed by hand into a fact agy reuses on later forms.

> **Using Claude Code?** Open this folder in it and say *"set this up for me"*. CLAUDE.md
> walks it through every step below and tells it what to ask you.

## What you need

- macOS (Linux works too, but you run the bridge yourself instead of using the installer)
- Google Chrome
- Python 3.9+ (`python3 --version`)
- [agy](https://antigravity.google) (the Antigravity CLI), signed in. Run `agy` once in a terminal.
- A Notion account

## Setup

Keep the folder **outside Desktop, Documents and Downloads** (e.g. `~/form-quickfill`).
macOS blocks background agents from reading those folders.

**1. Your details**

```bash
cp .env.example .env
cp config/profile.example.json config/profile.json
cp config/facts.example.json config/facts.json
```

Fill in `config/profile.json` (who you are, your message, your links, your Gmail accounts)
and `config/facts.json` (what agy may say about you). Every `YOUR-…` / `Your Name` /
`you@example.com` value has to go. The doctor (step 6) lists any that are left.

**2. Notion**

1. Go to https://www.notion.so/profile/integrations → **New integration** (internal) →
   copy the secret into `.env` as `NOTION_TOKEN=…`.
2. Make (or pick) a Notion page for the database. Open it → **•••** (top right) →
   **Connections** → add your integration.
3. Create the database:
   ```bash
   python3 scripts/setup_notion.py "<link to that page>" --title "Shopify Leads"
   ```
   It saves the database id to `.env`. (Already have a leads database? Use
   `--existing "<database link>"` and match its columns to `bridge/schema.py`.)

**3. Leads**

Put your leads in a CSV (only `agency` and `website` are needed):

```csv
agency,website,form_link,email,short_name,priority,form_type,country,directory_link
Acme Commerce,acme.com,https://acme.com/contact,hello@acme.com,Acme,5,Contact,Canada,https://www.shopify.com/partners/directory/partner/acme
```

```bash
python3 scripts/import_leads.py data/leads.csv     # safe to rerun: skips sites already in Notion
```

Optional but worth it: find each agency's founder so messages open with their name.

```bash
pip3 install -r requirements.txt
python3 scripts/find_founders.py                   # only scans leads with an empty Founder
```

**4. The bridge** (a small local server the extension talks to on `127.0.0.1:8131`)

```bash
bash scripts/install_mac.sh        # macOS: starts now and at every login
# or, anywhere: python3 bridge/bridge.py   (keep the terminal open)
```

**5. The extension**

`chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick the
`extension/` folder. Pin it, then click its icon to open the side panel.

**6. Check everything**

```bash
python3 scripts/doctor.py --agy
```

## Using it

| Button | What it does |
|---|---|
| **Next lead** | Opens the next lead (highest Priority first, contact forms before careers) and fills it |
| **Fill this page** (Alt+Shift+F) | Fills the form on the current tab: use it after opening a popup form or another page |
| **Open email instead** | Gmail compose with the message, to the Notion email or the best one on the page; rotates your accounts |
| **Remember this** | Saves answers you typed yourself as facts for future forms |
| **Mark sent** | Logs a send the panel didn't spot by itself |
| **Skip** | Ticks Hand skipped in Notion, with the reason; the lead never comes back |

Green outlines are fields the rules filled, purple ones agy filled, amber ones need you, red
ones are problems (a required phone field, say). The **Copy** list has every value for forms
the extension can't reach (iframes, multi-step widgets).

Every send and skip is also written to `data/sent-log.tsv`. If Notion is down, sends are
parked in `data/pending-sent.json` and logged when it's back.

## config/profile.json

| Key | Used for |
|---|---|
| `you` | Name, email, company, website, job title, country (for required country fields), `phone` (leave `""` and phone fields stay empty) |
| `pitch` | One line telling agy who you are and why you're writing |
| `answers.how_heard`, `answers.what_needed` | "How did you hear about us" / "What do you need" fields |
| `prefer_options` | Regexes for picking dropdown options without agy (`hear`, `service`) |
| `greeting_named`, `greeting_anonymous` | `{greeting}` with and without a founder name (`{first}`) |
| `subject`, `message`, `short`, `tiny` | Templates using `{greeting}` and `{agency}`. `short` is used when a box caps the length, `tiny` when it caps it under `short` |
| `copy_links` | Extra Copy buttons (video, calendar, portfolio…) |
| `gmail_accounts` | `{name, email, u}` per account. `u` is the N in `mail.google.com/mail/u/N/` for that account in your Chrome. Emails rotate through them |

Profile and facts changes need no restart: close and reopen the side panel.

## Layout

```
extension/          Chrome side panel (sidepanel.*), page script (content.js), message templates
bridge/bridge.py    local server: Notion queue + writes, agy calls
bridge/schema.py    every Notion column name, in one place
bridge/agy/         sealed agy runner: a tool gate refuses everything but returning the answer
config/             profile + facts (.example.json are templates; your copies are gitignored)
scripts/            setup_notion, import_leads, find_founders, doctor, install_mac / uninstall_mac
data/               send log, parked sends, bridge.log (gitignored)
```

## Troubleshooting

- **"Bridge not running"**: `launchctl list | grep form-quickfill`. The log is `data/bridge.log`.
  Rerun `bash scripts/install_mac.sh` after editing `bridge/*.py`.
- **agy failures**: `bridge/agy/logs/last-failure.log`. Check that `QF_MODEL` in `.env` is a
  model your agy accepts, and `python3 scripts/doctor.py --agy`.
- **Gmail tab opens the wrong account**: the `/u/N` numbers in Chrome changed. Fix `u` in
  `gmail_accounts`.
- **Extension edits**: hit reload on `chrome://extensions`.
