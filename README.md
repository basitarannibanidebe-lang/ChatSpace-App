# ChatSpace

A starter messaging website for Netlify + Supabase. Includes username/password sign-in, text messages, voice-note recording, and private file attachments.

## Files
- `index.html` — page structure
- `style.css` — responsive dark UI
- `app.js` — Supabase authentication and chat behavior
- `config.js` — paste your project URL and publishable key here
- `database_setup.sql` — extra database policies/function to run after the initial setup

## 1. Configure Supabase
1. Open `config.js`.
2. Replace `PASTE_YOUR_SUPABASE_PROJECT_URL_HERE` with your Project URL.
3. Replace `PASTE_YOUR_SUPABASE_PUBLISHABLE_KEY_HERE` with your publishable key (`sb_publishable_...`, or the legacy anon key if your dashboard still provides it).
4. Never put a service-role key or database password in browser code.

## 2. Database setup
You already ran the initial SQL from the guided setup. In Supabase SQL Editor, create a new query, paste all of `database_setup.sql`, and run it.

Important: this is a starter setup. Before public launch, review all RLS policies, test with two separate accounts, and confirm that a non-participant cannot read messages or download files.

## 3. Authentication note
This starter maps usernames to synthetic addresses under `users.chatspace.invalid` so the login form can accept a username without asking for a real email address. It depends on Supabase Email auth being enabled and email confirmation being disabled. It is not a deliverable-email login system. Usernames are limited to lowercase letters, numbers, and underscores.

## 4. Storage
Create a **private** Storage bucket named `chat-attachments`. Use the storage policies you already ran. Files are stored under `<conversation-uuid>/<user-uuid>/<random-file-name>`.
This starter creates seven-day signed URLs. For a production app, consider generating signed URLs only after checking current conversation membership, rather than storing signed URLs in message rows. Signed URLs remain usable until they expire.

## 5. Test locally
Open the folder in VS Code and use the Live Server extension, or run a local static server. Microphone recording requires localhost or HTTPS. Opening `index.html` directly as a `file://` URL may not work correctly.

## 6. Deploy to Netlify
1. Put all files in one folder.
2. Drag the folder into Netlify Drop, or push it to a Git repository and import it into Netlify.
3. After deployment, open the Netlify URL and test with two accounts.
4. In Supabase, set the correct Site URL and allowed redirect URLs under Authentication > URL Configuration if you add redirects later.

## Limits in this starter
- Upload limit: 10 MB per file/voice note.
- Voice notes use browser MediaRecorder and request microphone permission.
- The starter is a foundation, not a fully audited production chat service. Review security policies, file access, rate limiting, abuse reporting, and account recovery before sharing widely.
