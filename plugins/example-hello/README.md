# neotavern.example-hello

Reference plugin for the NeoTavern plugin SDK (ТЗ §7). Demonstrates:

- `plugin.json` manifest (reverse-DNS id, `apiVersion`, permissions);
- frontend registrations: toolbar action, command-palette command, slash command, notification;
- backend route served from the isolated worker process at
  `GET /api/plugins/neotavern.example-hello/hello`.

## Installing

Package the directory contents (not the directory itself) as a ZIP with
`plugin.json` at the archive root and the `.stplugin` extension, then install
through the app's plugin manager:

```powershell
Compress-Archive -Path plugins/example-hello/* -DestinationPath neotavern.example-hello.stplugin
```

The manager shows the requested permissions (`ui.toolbar`, `notifications`,
`server.routes`) for consent before activation.
