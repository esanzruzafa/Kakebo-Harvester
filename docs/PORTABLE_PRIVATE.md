# Private runtime files

This directory is intentionally distributed with templates only.

Copy `.env.production.example` to `.env.production`, add your own Enable
Banking application identifier and PEM key, and generate a unique
`SESSION_ENCRYPTION_KEY`. Kakebo Harvester creates the local HTTPS PFX and
passphrase for the current Windows user when they are missing.

Never commit, publish, email, or include the completed contents of this
directory in a support request or GitHub issue.
