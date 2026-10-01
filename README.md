# School Election Web App

This is a re-implementation of my original code, which I wrote for the student elections at school. The original version used MySQL. This version uses SQLite instead, which keeps deployment much simpler because the server computer does not need a separate database service.

SQLite suits this version because the election runs from one server machine and several browser-based voting machines over the local network. The server saves every vote in a local database. The other computers only display a ballot and send the selected candidate to that server.

## Requirements and architecture

The server computer needs **Python 3.10 or newer** on Windows, Linux or macOS. The app uses Python's standard library, SQLite, HTML, CSS and vanilla JavaScript. There are no Python packages to install and no build step.

Keep the server and voting machines on the same trusted LAN. The server must stay running throughout the election. Ordinary HTTP works, for example `http://192.168.1.3:8080`; HTTPS and internet access are not required.

| Page | Use |
| --- | --- |
| `http://localhost:8080/admin` | Setup and election controls, on the server computer only |
| `http://192.168.1.3:8080/vote/a` | Dedicated Panel A voting machine |
| `http://192.168.1.3:8080/vote/b` | Dedicated Panel B voting machine |
| `http://192.168.1.3:8080/results` | Results display or projector |
| `http://192.168.1.3:8080/vote` | Links to the two separate panels |

Replace `192.168.1.3` with your server's actual LAN address. Use `localhost` for administration; admin requests from other computers are blocked. Candidate standings are never shown in the control page or public APIs while voting is active.

## Start the server

Extract the ZIP before running it. On Windows, double-click **START_SERVER.bat**, or open a terminal in the extracted folder and run:

```text
py -3 server.py
```

If the Python launcher is unavailable, use `python server.py`. On Linux or macOS:

```sh
python3 server.py
```

The terminal prints the admin, voting and results addresses. Leave that terminal open. Press **Ctrl+C** to stop the server. `start_server.sh` is also provided for Linux and macOS.

Port 8080 is the default. To choose another port in Windows Command Prompt:

```bat
set ELECTION_PORT=8090
py -3 server.py
```

On Linux or macOS, run `ELECTION_PORT=8090 python3 server.py`. Use the same port in every voting-machine address.

### Find the server's IP on Windows

Open Command Prompt and run `ipconfig`. Find the **IPv4 Address** under the connected Ethernet or Wi-Fi adapter. Use that address on the voting computers. Do not use a VPN, disconnected adapter or virtual-machine adapter address. You can also copy the voting addresses shown in the admin page.

## Set up the election

1. Open `/admin` on the server computer using `localhost`.
2. Under **Election setup**, enter the school name, an optional election name, and the main and second-place role names for both panels. Click **Save setup**.
3. Use **Add candidate** in each panel. Enter the candidate's name, optional class/section and photo. The preview shows the photograph before saving.
4. **Edit** can change a candidate's name, class, photo or assigned panel. **Delete** removes a candidate. Setup becomes locked once voting opens.
5. Add at least **two candidates to each panel**, since each panel elects two roles.
6. Prepare the audio file as described below.
7. Open `/vote/a` on Panel A machines and `/vote/b` on Panel B machines. Press **F11** in Chrome, Edge or Firefox on Windows to enter fullscreen. Use the browser's fullscreen command on other systems.

JPEG, PNG and WebP photos up to **80 MB** are accepted by the candidate editor. The browser resizes them to at most 1400 × 1600 pixels and compresses them before uploading, so normal large phone and camera photos work without a Python imaging dependency. Export HEIC/RAW photos as JPEG first. Choose a portrait with the face near the centre; voting and results screens crop it to fit. Photos are optional; initials appear when none is supplied.

## Election-day workflow

1. Check the candidate photos, role names, voting-machine addresses and fullscreen views. The admin page reports recently connected machines and total votes for each panel.
2. Run a short practice election. Pause or close it, then use **Reset votes** before the real election.
3. Click **Open voting** and confirm. Each machine shows only the candidates on its assigned panel.
4. A voter clicks the candidate's whole photo/name tile. The server records the vote immediately. After confirmation, the entire screen turns green and displays **VOTED** for **5 seconds**, then returns to the same panel for the next voter.
5. **Pause voting** replaces the ballots with the amber **VOTING PAUSED** screen. **Resume voting** restores them. Machines check the state about every 1.5 seconds.
6. **Close voting** and confirm when the election finishes. Machines show the red **VOTING CLOSED** screen. A closed election cannot be reopened; votes must be reset to start again.
7. Click **Publish results** and confirm. Open `/results` on the projector. Results remain hidden until this action. **Unpublish results** hides the display again while keeping the votes and the closed state.

A vote already confirmed keeps its green screen for the full five seconds, even if voting is paused or closed during that interval. The next screen then reflects the current election state.

## Main and second-place roles

Panel A and Panel B are independent ballots. Default role names are Head Boy / Assistant Head Boy and Head Girl / Assistant Head Girl; change all four names to suit your election. The calculation uses panels and configured labels, without gender assumptions.

For each panel, the highest vote total receives the main role and the second-highest receives the second-place role. There is no separate assistant ballot. The results page shows the elected candidates with photographs and vote totals, followed by the complete ranking.

Ties affecting first or second place are displayed explicitly; names, candidate IDs and setup order never break a tie. If first place is tied, neither role is assigned until the school resolves the tie outside this application. If only second place is tied, the main winner is shown and the second-place role is marked unresolved. A panel with no votes elects nobody. Ranking uses competition positions, for example 1, 1, 3.

## Reliability and resets

Double-clicks are blocked while a vote is being saved and during the confirmation screen. Each request has a vote reference, reused on network retries. Retrying that reference cannot add a second vote, including when voting was paused or closed after the first request succeeded.

If a response is lost, the machine retries the same request. If it still cannot confirm the result, it displays **VOTE NOT CONFIRMED** and a retry button. Keep that tab open and retry before admitting the next voter. Reloading the same tab also retries its pending request. Avoid closing it while a vote is unconfirmed. A request left over from a reset cannot enter the new election.

Restarting the server during open voting returns the election to **paused**. Check the machines, then resume deliberately. A closed or published election stays closed after restart.

**Reset votes** requires typing `RESET VOTES` in the confirmation dialog. Pause or close voting first. Reset permanently deletes the votes, hides results and returns to setup. School details, role names, candidates and photos are kept. Back up before resetting if you need the old results.

## Database and backups

The first startup creates `data/election.db`, plus `data/uploads/candidates/` for photographs. SQLite writes are committed before a vote is confirmed. The app uses SQLite's write-ahead log and serialises writes within the server.

To back up, stop the server with **Ctrl+C**, then copy the **whole data folder** to a safe location. Copy the entire folder, including any `election.db-wal` or `election.db-shm` files still present. To restore, stop the server and replace its `data` folder with the backup. Copy the application and its data together when moving to another computer. Run only one server instance for a data folder.

Existing databases from the supplied version are updated automatically; candidates, settings and recorded votes are retained. The new election reference is added without replacing the existing schema.

## LAN troubleshooting

- First check `http://localhost:8080/admin` on the server. If it cannot load, check the terminal and Python installation. If the port is already in use, close the old instance or choose another port.
- If only the other computers cannot connect, check the IPv4 address, port and shared network. Keep the server's network address stable for election day.
- On Windows, allow Python through **Windows Defender Firewall** for the **Private** network when prompted. For a trusted school LAN, ensure the network is marked Private. If necessary, create an inbound TCP rule for your chosen port on that network profile.
- Guest Wi-Fi and access-point client isolation can prevent computers from reaching one another. Use the same normal Wi-Fi or wired LAN, or ask the network administrator to allow local connections.
- Use a current Chrome, Edge or Firefox. Enable JavaScript, allow site storage, and avoid extensions that modify pages. Test one machine of each type before election day.
- A machine that loses connection hides its ballot and reconnects automatically. If its vote is unconfirmed, use the on-screen retry rather than making another selection.

## Folder structure

```text
School-Election-WebApp/
  LICENSE                     GNU GPL v3.0 license
  README.md
  server.py
  START_SERVER.bat
  start_server.sh
  static/
    common.css / common.js     shared design tokens and small helpers
    admin.html / .css / .js    election control and candidate editor
    vote.html / .css / .js     separate ballots and full-screen states
    results.html / .css / .js  published results and rankings
    vote-select.html           panel selection page
    select.css / select.js
    favicon.svg
    vote.mp3                   
  data/                        created at runtime; normally not committed
    election.db
    uploads/candidates/
```

## Limitations

This is a supervised, local-network school election. It does not register voters, verify eligibility or enforce one vote per person. Staff must manage the voter list and access to machines. Both panels may need different supervision rules depending on the school's election.

The voting screens are ordinary browser tabs, not an operating-system kiosk. Fullscreen does not prevent leaving the browser. The server is intended for a trusted LAN, with administration restricted to loopback; it is not an internet-hosted election service. If the server is unavailable, votes cannot be accepted offline.

The voting layouts are designed for 1366 × 768 and 1920 × 1080 displays. Very large candidate counts, long names or small screens can require scrolling. Resolve ties according to the school's rules; this app never chooses a tied candidate automatically.

## License

This project is licensed under the **GNU General Public License v3.0 (GPLv3)**.

You may use, study, modify and redistribute this software under the terms of GPLv3. If you distribute this project or a modified version, you must provide the corresponding source code under GPLv3 as well, so recipients receive the same freedoms to use, study, modify and redistribute it.

See [`LICENSE`](LICENSE) for the full license text.
