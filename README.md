# Switch Sim

A phone app for practicing Cisco switch configuration. A simulated IOS console
(user / privileged / global-config modes, abbreviations, `?` help, Tab completion)
with a guided Lesson 1 lab and quiz. Works offline.

## How it is built

- `app/src/main/assets/` is the actual app: `engine.js` (the simulated switch),
  `lesson1.js` (steps and quiz), `index.html`, `style.css`, `app.js` (UI).
- `app/src/main/java/.../MainActivity.java` is a thin Android WebView that loads those files.
- `.github/workflows/build.yml` runs the engine tests, then builds a debug APK with Gradle.

## Push from Termux and build on GitHub

```sh
termux-setup-storage                       # once, allow storage access
cd ~
unzip ~/storage/downloads/switch-sim.zip
cd switch-sim

pkg install git gh                         # once
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
gh auth login                              # once, follow the prompts

git init -b main
git add .
git commit -m "Switch Sim starter"
gh repo create switch-sim --public --source=. --push
```

Then open the repo on GitHub, go to **Actions**, open the latest **Build APK** run,
and download **SwitchSim-debug-apk** from the Artifacts section. Unzip it, open
`app-debug.apk` on your phone, and allow "install unknown apps" if asked.

## Develop faster (no APK needed)

The app is plain HTML/JS, so you can try changes in the phone browser:

```sh
cd app/src/main/assets
python -m http.server 8080                 # then open http://localhost:8080
node ../../../../tests/engine.test.js      # run engine tests
```

## Add commands or lessons

- New switch commands: add an entry to `USER_CMDS`, `PRIV_CMDS` or `CONFIG_CMDS` in `engine.js`
  (`{ p: 'hostname <name>', run: fn, desc: '...' }`) and a test in `tests/engine.test.js`.
- New lesson: copy `lesson1.js`, edit the steps and quiz, and load it from `index.html`.
- Lesson 2 candidates: `line console 0` + `password` + `login`, `interface vlan 1` +
  `ip address`, `show interfaces`, `show ip interface brief`.

## Notes

- The `enable secret` hash in `show running-config` is simulated, not a real hash.
- Progress is saved in the WebView's local storage and cleared by Reset.
- The debug APK is signed with a debug key, which is fine for installing on your own phone.
