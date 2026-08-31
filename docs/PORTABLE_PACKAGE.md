# Kakebo Harvester portable package

This archive contains the Windows portable executable and the public starter
structure needed for a new local installation. It deliberately contains no
credentials, private keys, bank sessions, personal configuration, database,
transactions, raw provider responses, or exports.

## First-time setup

1. Extract the complete archive to a private folder owned by your Windows user.
2. Copy `private/.env.production.example` to
   `private/.env.production` without modifying the example file.
3. Create an Enable Banking production application and place its private PEM
   key in `private/enable-banking-production.pem`.
4. Set `ENABLE_BANKING_APPLICATION_ID` in `private/.env.production`.
5. Generate 32 random bytes as Base64 and set the result as
   `SESSION_ENCRYPTION_KEY`. In Windows PowerShell:

   ```powershell
   $bytes = New-Object byte[] 32
   [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
   [Convert]::ToBase64String($bytes)
   ```

6. Start `Kakebo-Harvester-<version>-x64.exe` and allow the application to
   prepare local HTTPS for the current Windows user.
7. Run Doctor from the application, then connect the required banks.

The application creates missing operational configuration and database files.
Files under `config/` are examples for reference or customization; the visible
settings can also be edited from the application. Do not rename or prefill the
account example before connecting a real bank.

## Existing installation

To upgrade an existing installation, replace only the executable and preserve
the existing `private/`, `config/`, and `data/` folders. Back up the installation
before moving it to another computer, and close both the UI and scheduled tasks
before copying SQLite files.

## Security

Never publish or share `private/.env.production`, PEM files, passphrases,
databases, raw responses, exports, or personal configuration. Verify the
downloaded ZIP with the adjacent `.sha256` file from the GitHub Release.

Full documentation: https://esanzruzafa.github.io/Kakebo-Harvester/
