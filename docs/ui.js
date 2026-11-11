import { Game, categories, categoryCount, diceCount, upperTotal, bonus, total } from './game.js';

const get = id => document.getElementById(id);
const setup = get('setup');
const board = get('game');
const rulesDialog = get('rules-dialog');
const restartDialog = get('restart-dialog');
const shareDialog = get('share-dialog');
const shareUrl = 'https://hanus01.github.io/super-yatzy/';
const scoreScroll = get('score-scroll');
const scoreTable = get('score-table');
const scoreScrollHint = get('score-scroll-hint');
const scoreInput = get('manual-score');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const names = Array.from({ length: 8 }, (_, i) => `Player ${i + 1}`);
const diceModes = names.map(() => 'digital');
let humanCount = 1;
let game;
let selectedCategory = null;
let computerTimer;
let rollTimer;
let computerWillRoll = false;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function option(value, label) {
  const element = node('option', label);
  element.value = value;
  return element;
}

function text(id, value) {
  const element = get(id);
  if (element.textContent !== value) element.textContent = value;
}

function renderPlayers() {
  const settings = get('player-settings');
  while (settings.children.length > humanCount) settings.lastElementChild.remove();
  for (let i = settings.children.length; i < humanCount; i++) {
    const row = node('div', undefined, 'player-setting');
    const nameLabel = node('label', `Player ${i + 1} name`);
    const name = node('input');
    name.type = 'text';
    name.value = names[i];
    name.maxLength = 36;
    name.required = true;
    name.autocomplete = 'off';
    name.addEventListener('input', () => {
      names[i] = name.value;
      name.setCustomValidity('');
    });
    nameLabel.append(name);

    const diceLabel = node('label', 'Dice');
    const dice = node('select');
    dice.setAttribute('aria-label', `Player ${i + 1} dice`);
    dice.append(option('digital', 'On this device'), option('physical', 'Physical dice'));
    dice.value = diceModes[i];
    dice.addEventListener('change', () => { diceModes[i] = dice.value; });
    diceLabel.append(dice);
    row.append(nameLabel, diceLabel);
    settings.append(row);
  }
  text('player-count', String(humanCount));
  get('remove-player').disabled = humanCount === 1;
  get('add-player').disabled = humanCount === names.length;
}

function readPlayers() {
  const players = [];
  for (let i = 0; i < humanCount; i++) {
    const name = names[i].trim();
    if (!name) {
      const input = get('player-settings').children[i].querySelector('input');
      input.setCustomValidity('Give this player a name.');
      input.reportValidity();
      return null;
    }
    players.push({ name, physicalDice: diceModes[i] === 'physical' });
  }
  if (get('computer-option').checked) players.push({ name: 'Computer', computer: true });
  return players;
}

function resetTurnControls() {
  selectedCategory = null;
  computerWillRoll = false;
  scoreInput.value = '';
  text('skipped-summary', '');
  showScoreFeedback('');
}

function beginGame(players = readPlayers()) {
  if (!players) return;
  clearTimeout(computerTimer);
  clearTimeout(rollTimer);
  game = new Game(players);
  resetTurnControls();
  showGame();
  scoreScroll.scrollLeft = 0;
}

function showSetup() {
  clearTimeout(computerTimer);
  board.hidden = true;
  setup.hidden = false;
  get('open-setup').hidden = true;
  get('back-to-game').hidden = !game;
  get('setup-title').focus();
  window.scrollTo(0, 0);
}

function showGame() {
  setup.hidden = true;
  board.hidden = false;
  get('open-setup').hidden = false;
  renderGame();
  get(game.finished ? 'results-title' : 'turn-title').focus();
  window.scrollTo(0, 0);
  scheduleComputer();
}

const diceButtons = Array.from({ length: diceCount }, (_, i) => {
  const button = node('button', undefined, 'die');
  button.type = 'button';
  for (let pip = 0; pip < 9; pip++) button.append(node('span', undefined, 'pip'));
  button.addEventListener('click', () => {
    if (game.toggleHold(i)) renderTurn();
  });
  get('dice').append(button);
  return button;
});

const categoryButtons = categories.map(({ name }, index) => {
  const button = node('button', undefined, 'category');
  const value = node('span', '—', 'category-value');
  button.type = 'button';
  button.append(node('span', name), value);
  button.addEventListener('click', () => {
    selectedCategory = index;
    scoreInput.value = '';
    showScoreFeedback('');
    renderChoices();
    if (isPhysical()) scoreInput.focus();
  });
  get('categories').append(button);
  return { button, value };
});

function renderGame() {
  board.classList.toggle('is-finished', game.finished);
  get('turn').hidden = game.finished;
  get('choices').hidden = game.finished;
  get('results').hidden = !game.finished;
  if (game.finished) renderResults();
  else {
    renderTurn();
    renderChoices();
  }
  renderScorecard();
}

function isPhysical() {
  return !game.current().computer && game.current().physicalDice;
}

function renderTurn() {
  const player = game.current();
  const physical = isPhysical();
  const pending = game.pendingRoll;
  const editing = !player.computer && !game.turnRecorded && !pending;
  text('round-label', `Round ${game.round} of ${categoryCount}`);
  text('turn-title', `${player.name}’s turn`);
  text('roll-count', physical ? 'Physical dice' : `${pending?.number ?? game.rolls} of 3 rolls`);
  get('digital-tray').hidden = physical;
  get('digital-actions').hidden = physical || player.computer || game.turnRecorded;
  get('physical-tray').hidden = !physical || game.turnRecorded;

  if (!physical) {
    for (const [i, die] of diceButtons.entries()) {
      const moving = Boolean(pending?.moving[i]);
      const face = game.hasDice() ? game.dice[i] : null;
      const kept = game.held[i] && !moving;
      die.dataset.face = face ?? '';
      die.classList.toggle('is-empty', face === null);
      die.classList.toggle('is-rolling', moving);
      die.classList.toggle('is-held', kept);
      die.disabled = !editing || !game.hasDice() || game.rolls >= 3;
      die.setAttribute('aria-pressed', String(kept));
      die.setAttribute('aria-label', `Die ${i + 1}${face === null ? ', ready to roll' : `, ${face}`}${kept ? ', kept' : ''}`);
    }
    const roll = get('roll-dice');
    roll.disabled = !editing || !game.canRoll();
    text('roll-dice', pending ? 'Rolling…' : game.rolls === 0 ? 'Roll six dice'
      : game.rolls >= 3 ? 'All rolls used' : 'Roll again');
    get('release-dice').disabled = !editing || game.rolls >= 3 || !game.held.some(Boolean);
    let instruction = 'Roll the dice to start your turn.';
    if (game.turnRecorded) instruction = 'This turn is complete.';
    else if (pending) instruction = 'Rolling…';
    else if (player.computer) instruction = computerWillRoll ? 'The computer is keeping dice for its next roll.' : 'The computer is playing.';
    else if (game.rolls >= 3) instruction = 'Choose a category to finish your turn.';
    else if (game.held.every(Boolean)) instruction = 'All dice kept. Release a die to roll again or choose a category.';
    else if (game.hasDice()) instruction = 'Tap dice to keep or release them, or choose a category now.';
    text('dice-instruction', instruction);
  }

  const upper = upperTotal(player.card);
  text('bonus-label', upper >= 84 ? 'Upper bonus earned · +50' : `Upper bonus · ${upper} / 84`);
  get('bonus-progress').value = Math.min(upper, 84);
  get('turn-complete').hidden = !game.turnRecorded;
  if (game.turnRecorded) {
    const last = game.round === categoryCount && game.activeIndex === game.players.length - 1;
    const next = game.players[(game.activeIndex + 1) % game.players.length].name;
    text('recorded-summary', recordedScore());
    text('continue-turn', last ? 'See final results' : `Continue to ${next}`);
  }
  const computerNext = game.turnRecorded && game.players[game.activeIndex + 1]?.computer;
  const canSkip = computerNext || (player.computer && !game.turnRecorded);
  get('skip-computer').hidden = !canSkip;
  if (canSkip) {
    const next = game.round === categoryCount ? 'See final results' : `Continue to ${game.players[0].name}`;
    text('skip-computer', `${next} (skip animation)`);
  }
}

function recordedScore() {
  const unit = game.lastPoints === 1 ? 'point' : 'points';
  return `${game.current().name} recorded ${categories[game.lastCategory].name} for ${game.lastPoints} ${unit}.`;
}

function canChoose() {
  if (game.finished || game.turnRecorded || game.current().computer || game.pendingRoll) return false;
  return isPhysical() || game.hasDice();
}

function manualPoints() {
  const value = scoreInput.value.trim();
  return /^\d+$/.test(value) ? Number(value) : null;
}

function showScoreFeedback(message) {
  text('score-feedback', message);
  get('score-feedback').hidden = !message;
}

function renderChoices() {
  const player = game.current();
  const manual = isPhysical();
  const enabled = canChoose();
  const scores = enabled && !manual ? game.candidateScores() : null;
  for (const [i, { button, value }] of categoryButtons.entries()) {
    const recorded = player.card[i];
    const points = recorded ?? scores?.[i] ?? null;
    button.disabled = !enabled || recorded !== null;
    button.setAttribute('aria-pressed', String(enabled && selectedCategory === i));
    button.classList.toggle('is-recorded', recorded !== null);
    const description = points === null ? '' : `, ${points} ${points === 1 ? 'point' : 'points'}${recorded !== null ? ' recorded' : ''}`;
    button.setAttribute('aria-label', categories[i].name + description);
    value.textContent = points ?? '—';
  }
  let help = 'Tap an open category to see your choice before recording it.';
  if (game.turnRecorded) help = 'Continue to play the next turn.';
  else if (player.computer) help = 'The computer chooses its own category.';
  else if (!enabled) help = 'Roll the dice to see the available scores.';
  else if (manual) help = 'Choose an open category, then enter its points.';
  text('choices-help', help);

  const action = get('score-action');
  action.hidden = !enabled || selectedCategory === null;
  if (action.hidden) return;
  text('selected-category', categories[selectedCategory].name);
  get('manual-score-label').hidden = !manual;
  const points = manual ? manualPoints() : scores[selectedCategory];
  const record = get('record-score');
  record.disabled = points === null;
  record.classList.toggle('scratch', points === 0);
  text('record-score', points === null ? 'Record score' : points === 0 ? 'Scratch · 0 points'
    : `Record ${points} ${points === 1 ? 'point' : 'points'}`);
}

function updateScoreScrollHint() {
  scoreScrollHint.hidden = scoreScroll.scrollWidth <= scoreScroll.clientWidth;
}

function renderScorecard() {
  const head = node('thead');
  const header = node('tr');
  for (const label of ['Category', 'Max']) {
    const cell = node('th', label);
    cell.scope = 'col';
    header.append(cell);
  }
  for (const [index, player] of game.players.entries()) {
    const cell = node('th', player.name, 'player-score');
    cell.scope = 'col';
    if (!game.finished && index === game.activeIndex) cell.classList.add('current-score');
    header.append(cell);
  }
  head.append(header);
  const body = node('tbody');
  function row(label, maximum, pointsFor, className) {
    const line = node('tr', undefined, className);
    const name = node('th', label);
    name.scope = 'row';
    line.append(name, node('td', maximum, 'score-max'));
    for (const [index, player] of game.players.entries()) {
      const cell = node('td', pointsFor(player.card) ?? '—');
      if (!game.finished && index === game.activeIndex) cell.classList.add('current-score');
      line.append(cell);
    }
    body.append(line);
  }
  for (const [i, { name, maximum }] of categories.entries()) {
    row(name, maximum, card => card[i]);
    if (i === 5) {
      row('Upper sum', 126, upperTotal, 'score-summary');
      row('Bonus (84+)', 50, bonus, 'score-summary');
    }
  }
  row('Total', '—', total, 'score-summary score-total');
  scoreTable.replaceChildren(head, body);
  updateScoreScrollHint();
}

function renderResults() {
  const winners = game.winners();
  const ranked = game.players.map((player, index) => ({ ...player, index, points: total(player.card) }))
    .sort((first, second) => second.points - first.points);
  text('results-title', game.players.length === 1 ? 'Final score'
    : winners.length === 1 ? `${game.players[winners[0]].name} wins!` : 'A shared victory!');
  get('rankings').replaceChildren(...ranked.map(player => {
    const item = node('li', undefined, winners.includes(player.index) ? 'winner' : '');
    item.append(node('span', player.name), node('strong', `${player.points} points`));
    return item;
  }));
}

function rollDice() {
  const match = game;
  if (!match.beginRoll()) return;
  selectedCategory = null;
  computerWillRoll = false;
  renderTurn();
  renderChoices();
  rollTimer = setTimeout(() => {
    if (match !== game || !match.commitRoll()) return;
    renderTurn();
    renderChoices();
    scheduleComputer();
  }, reduceMotion.matches ? 0 : 280);
}

function scheduleComputer() {
  clearTimeout(computerTimer);
  const match = game;
  if (!match || board.hidden || rulesDialog.open || restartDialog.open || shareDialog.open || match.finished
    || match.turnRecorded || match.pendingRoll || !match.current().computer) return;
  computerTimer = setTimeout(() => {
    if (match !== game || board.hidden || rulesDialog.open || restartDialog.open || shareDialog.open) return;
    if (match.rolls === 0 || computerWillRoll) {
      rollDice();
      return;
    }
    const decision = match.computerDecision();
    if (!decision) return;
    if (decision.scoreNow) {
      if (!match.recordCategory(decision.category)) renderGame();
      return;
    }
    if (match.applyComputerHolds(decision.keep)) {
      computerWillRoll = true;
      renderTurn();
      scheduleComputer();
    }
  }, 430);
}

function recordScore() {
  if (selectedCategory === null || !canChoose()) return;
  const manual = isPhysical();
  const points = manual ? manualPoints() : null;
  if (manual && points === null) return;
  const error = game.recordCategory(selectedCategory, points);
  if (error) {
    showScoreFeedback(error);
    return;
  }
  renderGame();
  get('continue-turn').focus();
}

function nextTurn() {
  if (!game.advanceTurn()) return;
  resetTurnControls();
  showGame();
}

function skipComputer() {
  if (!game || game.finished || board.hidden) return;
  if (!game.current().computer) {
    if (!game.players[game.activeIndex + 1]?.computer || !game.advanceTurn()) return;
  }
  clearTimeout(computerTimer);
  clearTimeout(rollTimer);
  const complete = game.completeComputerTurn();
  const summary = complete ? recordedScore() : '';
  if (complete) game.advanceTurn();
  resetTurnControls();
  showGame();
  text('skipped-summary', summary);
}

async function shareGame() {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'Super Yatzy', url: shareUrl });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  const input = get('share-url');
  input.value = shareUrl;
  get('share-status').hidden = true;
  shareDialog.showModal();
}

async function copyGameLink() {
  const input = get('share-url');
  try {
    await navigator.clipboard.writeText(shareUrl);
    text('share-status', 'Link copied.');
  } catch {
    input.focus();
    input.select();
    text('share-status', 'Select and copy the link.');
  }
  get('share-status').hidden = false;
}

get('add-player').addEventListener('click', () => {
  humanCount++;
  renderPlayers();
});
get('remove-player').addEventListener('click', () => {
  humanCount--;
  renderPlayers();
});
get('setup-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!readPlayers()) return;
  if (game && !game.finished) {
    restartDialog.returnValue = '';
    restartDialog.showModal();
  } else beginGame();
});
get('open-setup').addEventListener('click', showSetup);
get('back-to-game').addEventListener('click', showGame);
get('play-again').addEventListener('click', () => {
  if (game.finished) beginGame(game.players);
});
get('change-players').addEventListener('click', showSetup);
get('share-game').addEventListener('click', shareGame);
get('copy-game-link').addEventListener('click', copyGameLink);
shareDialog.addEventListener('close', scheduleComputer);
get('open-rules').addEventListener('click', () => {
  clearTimeout(computerTimer);
  rulesDialog.showModal();
});
rulesDialog.addEventListener('close', scheduleComputer);
restartDialog.addEventListener('close', () => {
  if (restartDialog.returnValue === 'restart') beginGame();
  else showGame();
});
get('roll-dice').addEventListener('click', rollDice);
get('release-dice').addEventListener('click', () => {
  game.held.fill(false);
  renderTurn();
});
new ResizeObserver(updateScoreScrollHint).observe(scoreScroll);
scoreInput.addEventListener('input', () => {
  showScoreFeedback('');
  renderChoices();
});
get('score-action').addEventListener('submit', event => {
  event.preventDefault();
  recordScore();
});
get('continue-turn').addEventListener('click', nextTurn);
get('skip-computer').addEventListener('click', skipComputer);

document.addEventListener('keydown', event => {
  if (board.hidden || rulesDialog.open || restartDialog.open || shareDialog.open || game.finished || game.pendingRoll
    || event.ctrlKey || event.metaKey || event.altKey || event.repeat
    || event.target.closest('button, input, select, textarea, a, [contenteditable]')) return;
  if (event.key === 'Enter' && game.turnRecorded) {
    event.preventDefault();
    nextTurn();
  } else if (!game.current().computer && !game.turnRecorded) {
    if (event.code === 'Space' && game.canRoll()) {
      event.preventDefault();
      rollDice();
    } else if (/^[1-6]$/.test(event.key) && game.toggleHold(Number(event.key) - 1)) {
      event.preventDefault();
      renderTurn();
    } else if (event.key === 'Enter' && selectedCategory !== null) {
      event.preventDefault();
      recordScore();
    }
  }
});

renderPlayers();
