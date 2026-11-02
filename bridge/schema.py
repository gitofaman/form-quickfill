"""The Notion Leads database: every column name, in one place.

scripts/setup_notion.py creates a database with exactly these columns; the bridge and the
scripts read and write them by these names. To point everything at a database you already
have, change the names on the right to match its columns (keep the types).
"""

AGENCY = "Agency"                  # title: the agency's name as the directory lists it
SHORT_NAME = "Short name"          # text: what the message calls them ("Acme", not "Acme Digital | Shopify Plus Agency")
WEBSITE = "Website"                # url
FORM_LINK = "Form link"            # url: their contact (or careers) form; Website is used when this is empty
CONTACT_EMAIL = "Contact email"    # email: for "Open email instead"
FOUNDER = "Founder"                # text: "First (evidence)", or "none (...)"; filled by scripts/find_founders.py
STATUS = "Status"                  # select: To contact -> Contacted (or Not a fit, by hand)
FORM_TYPE = "Form type"            # select: Contact / Careers
PRIORITY = "Priority"              # number: higher goes first
HAND_SKIPPED = "Hand skipped"      # checkbox: ticked by Skip, so the lead never comes back
CONTACTED_FROM = "Contacted from"  # select: Contact / Careers / Email
LAST_CONTACTED = "Last contacted"  # date
EMAIL_ACCOUNT = "Email account"    # multi-select: which Gmail account(s) emailed them
EMAILED_TO = "Emailed to"          # text
COUNTRY = "Country"                # text
DIRECTORY_LINK = "Directory link"  # url: their listing in the partner directory
HISTORY = "History"                # text: one dated line per send / skip

# Status values
TO_CONTACT = "To contact"
CONTACTED = "Contacted"
NOT_A_FIT = "Not a fit"

TYPES = {
    AGENCY: "title", SHORT_NAME: "rich_text", WEBSITE: "url", FORM_LINK: "url",
    CONTACT_EMAIL: "email", FOUNDER: "rich_text", STATUS: "select", FORM_TYPE: "select",
    PRIORITY: "number", HAND_SKIPPED: "checkbox", CONTACTED_FROM: "select",
    LAST_CONTACTED: "date", EMAIL_ACCOUNT: "multi_select", EMAILED_TO: "rich_text",
    COUNTRY: "rich_text", DIRECTORY_LINK: "url", HISTORY: "rich_text",
}


def properties() -> dict:
    """The column definitions Notion's create-database call takes."""
    def options(*names):
        return {"options": [{"name": n} for n in names]}
    special = {STATUS: options(TO_CONTACT, CONTACTED, NOT_A_FIT),
               FORM_TYPE: options("Contact", "Careers"),
               CONTACTED_FROM: options("Contact", "Careers", "Email"),
               EMAIL_ACCOUNT: options(),
               PRIORITY: {"format": "number"}}
    return {name: {kind: special.get(name, {})} for name, kind in TYPES.items()}
