# config/

SOOYA writes `persona.json` and `models.json` here on first start.
Both files are runtime state and are intentionally NOT shipped in the release,
so an upgrade can never overwrite your persona or your model configuration.

See `docs/DEPLOYMENT.md` and `.env.example` for how to configure providers.
