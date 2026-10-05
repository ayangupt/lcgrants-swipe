# Matchbox

A swipe app for working through grant tasks on a phone, a few at a time.

Each grant is a matchbox label; each thing it needs from you (an open question, a pursue-or-pass
decision, a blocked item, a follow-up) is a match:

| Gesture | What it does |
|---|---|
| Swipe right / **Answer** | Answer or approve. Type it, or tap the mic and say it. |
| Swipe left / **Later** | Put it at the back of the pile (only on this phone). |
| Swipe down / **Pass** | On a pursue-or-pass card: pass on the grant. |
| Swipe up | On a follow-up card: they replied. |
| **About this grant** | Flip the label: what the grant funds, the award, links. |
| **What is this for?** | Where the answer goes in the application, the draft's note, what the organization's files say about any number involved, related passages from its other files, and the funder's question. **Explain more** asks Copilot for a longer explanation. |
| **Use this** | On a "Found in our files" card: send the value the organization's own records already give, with its source. Prefer something else? **What is this for? → Answer differently**. |
| Pencil (top right) | A note for Copilot that doesn't answer any card: a changed number, a new partner, a decision. Pick one grant or all grants. |
| Boxes (top right) | Every grant with matches left, nearest deadline first. |

Questions can be reworded by Copilot, with suggested answers you can tap to fill in (you can always edit
before sending). Copilot's text is labeled as Copilot's, and it can't add numbers that aren't already in
the draft or the organization's fact list. Before a question reaches you, the sync looks in the
organization's own files: values many files agree on are filled in without asking, and an answer Copilot
"found" must quote one of those files word for word.

Light at least one match a day to keep the flame going; the strip at the top counts toward a daily goal
you set in Settings.

## How it works

- **This repository only holds the app shell** (HTML, CSS, JS, icons). It contains no grant data.
- The data lives in a **private** repository. The app reads a task deck from that repo's pinned
  "Grant inbox" issue and sends your answers back as issue comments (`/answer`, `/pursue`, `/pass`, …),
  using a fine-grained GitHub token that is stored only in this phone's browser storage.
- A sync job in the private repo applies those comments to the drafts (about every 10 minutes) and
  rebuilds the deck.
- Offline? Answers wait on the phone and send when you're back online.

Try it with made-up sample data: open the app with `?demo` at the end of the address.

## Set up on a phone

1. Open the app's address in Safari (iPhone) or Chrome (Android).
2. Tap **Create a GitHub token**, choose **Only select repositories** and pick the private grant repo,
   set **Issues** to **Read and write**, and generate it.
3. Paste the token, check the repository name, and tap **Open the box**.
4. Share → **Add to Home Screen** for a full-screen app icon.

To forget the token on a phone: Settings → **Forget token on this phone**. To revoke it everywhere:
GitHub → Settings → Developer settings → Fine-grained tokens.
