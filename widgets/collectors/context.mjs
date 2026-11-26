// The app keeps the pipe open for the lifetime of this feed. Credentials never enter
// argv, the browser or the snapshot directory. Closing the app closes the pipe.
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
const commands = new Map();
export const context = await new Promise((resolve, reject) => {
  input.once('line', line => {
    try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
  });
  input.once('close', () => process.exit(0));
});
input.on('line', line => {
  const { instance, command } = JSON.parse(line);
  if (instance && command) commands.set(instance, { 'omlx.modelAction': JSON.stringify(command) });
});
export const preferences = () => ({ widgetStorage: Object.fromEntries(commands) });
