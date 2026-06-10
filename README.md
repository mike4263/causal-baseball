# Casual Baseball Scorekeeper with MLB Game Setup

A self-contained browser scorekeeper for watching baseball at home.

## New in this version

- Game setup screen
- Fetches MLB schedule from `statsapi.mlb.com`
- Defaults to Washington Nationals
- Loads official starting lineups from MLB game feed when available
- Falls back to manual entry when lineups are not posted yet
- Keeps the casual scoring interface from the previous version

## How to use

1. Unzip the folder.
2. Open `index.html` in a modern browser.
3. Choose the date and team.
4. Click **Find Games**.
5. Pick the game.
6. If lineups are posted, they will load automatically. If not, enter them manually or reopen setup later.

## Notes

- MLB starting lineups may not appear until a few hours before first pitch.
- This app uses public MLB Stats API endpoints directly from the browser.
- Internet access is required for game setup and lineup fetch.
- After setup, the scorekeeper itself works locally.
