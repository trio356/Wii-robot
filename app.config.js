// Expo dynamic config: app.json plus secrets from the environment.
// The Picovoice access key is NEVER hard-coded: export it when starting.
//   PICOVOICE_ACCESS_KEY=xxxx npx expo start --dev-client
// EAS builds: set it as an environment secret instead.
const base = require('./app.json');

module.exports = {
  ...base.expo,
  extra: {
    porcupineAccessKey: process.env.PICOVOICE_ACCESS_KEY ?? '',
  },
};
