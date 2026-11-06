// App entry. `--cli <command...>` and `--mcp [--allow-actions]` run GutCheck headless (no window,
// no tray, no single-instance lock), so the AppImage doubles as the command line and MCP server.
const argv = process.argv;
const at = argv.findIndex((a) => a === '--cli' || a === '--mcp');
if (at === -1) {
  require('./main');
} else {
  const { app } = require('electron');
  app.disableHardwareAcceleration();
  // Headless: an error must never open Electron's error dialog. A closed pipe (`| head`) ends quietly.
  for (const st of [process.stdout, process.stderr]) st.on('error', (e) => app.exit(e && e.code === 'EPIPE' ? 0 : 1));
  process.on('uncaughtException', (e) => { try { process.stderr.write(`gutcheck: ${e && e.stack}\n`); } catch {} app.exit(1); });
  const args = argv[at] === '--mcp' ? ['mcp', ...argv.slice(at + 1)] : argv.slice(at + 1);
  require('./cli').main(args).then((code) => app.exit(code), (e) => { process.stderr.write(`gutcheck: ${e && e.stack}\n`); app.exit(1); });
}
