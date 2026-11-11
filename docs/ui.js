import { Game, categories, categoryCount, diceCount, upperTotal, bonus, total } from './game.js';

const get = id => document.getElementById(id);
const setup = get('setup');
const board = get('game');
const rulesDialog = get('rules-dialog');
const restartDialog = get('restart-dialog');
const scorePlayer = get('score-player');
const scoreInput = get('manual-score');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const names = Array.from({ length: 8 }, (_, i) => `Player ${i + 1}`);
const diceModes = names.map(() => 'digital');
let humanCount = 1;
let game;
let selectedCategory = null;
let physicalMode = 'dice';
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
  physicalMode = 'dice';
  computerWillRoll = false;
  scoreInput.value = '';
  for (const die of physicalInputs) die.value = '';
  showScoreFeedback('');
}

function beginGame() {
  const players = readPlayers();
  if (!players) return;
  clearTimeout(computerTimer);
  clearTimeout(rollTimer);
  game = new Game(players);
  resetTurnControls();
  scorePlayer.replaceChildren();
  if (game.players.length > 1) scorePlayer.append(option('all', 'All players'));
  game.players.forEach(({ name }, i) => scorePlayer.append(option(String(i), name)));
  scorePlayer.value = game.players.length > 1 && matchMedia('(min-width: 820px)').matches ? 'all' : '0';
  showGame();
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

const physicalInputs = Array.from({ length: diceCount }, (_, i) => {
  const select = node('select');
  select.setAttribute('aria-label', `Final die ${i + 1}`);
  select.append(option('', '—'));
  for (let face = 1; face <= diceCount; face++) select.append(option(String(face), String(face)));
  select.addEventListener('change', () => {
    const dice = physicalInputs.map(input => Number(input.value));
    if (dice.every(Boolean)) game.setPhysicalDice(dice);
    showScoreFeedback('');
    renderChoices();
  });
  get('physical-dice').append(select);
  return select;
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

  if (physical) {
    get('physical-dice-mode').setAttribute('aria-pressed', String(physicalMode === 'dice'));
    get('physical-score-mode').setAttribute('aria-pressed', String(physicalMode === 'score'));
    get('physical-dice-controls').hidden = physicalMode === 'score';
    get('physical-score-note').hidden = physicalMode === 'dice';
  } else {
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
    const points = `${game.lastPoints} ${game.lastPoints === 1 ? 'point' : 'points'}`;
    text('recorded-summary', `${player.name} recorded ${categories[game.lastCategory].name} for ${points}.`);
    text('continue-turn', last ? 'See final results' : `Continue to ${next}`);
  }
}

function canChoose() {
  if (game.finished || game.turnRecorded || game.current().computer || game.pendingRoll) return false;
  if (!isPhysical()) return game.hasDice();
  return physicalMode === 'score' || physicalInputs.every(input => input.value);
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
  const manual = isPhysical() && physicalMode === 'score';
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
  else if (!enabled) help = isPhysical() ? 'Enter all six dice to see the available scores.' : 'Roll the dice to see the available scores.';
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

function renderScorecard() {
  const players = scorePlayer.value === 'all' ? game.players.map((_, i) => i) : [Number(scorePlayer.value)];
  get('score-player-label').hidden = game.players.length === 1;
  const head = node('thead');
  const header = node('tr');
  for (const label of ['Category', 'Max']) {
    const cell = node('th', label);
    cell.scope = 'col';
    header.append(cell);
  }
  for (const index of players) {
    const cell = node('th', game.players[index].name, 'player-score');
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
    for (const index of players) {
      const cell = node('td', pointsFor(game.players[index].card) ?? '—');
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
  get('score-table').replaceChildren(head, body);
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
  if (!match || board.hidden || rulesDialog.open || restartDialog.open || match.finished
    || match.turnRecorded || match.pendingRoll || !match.current().computer) return;
  computerTimer = setTimeout(() => {
    if (match !== game || board.hidden || rulesDialog.open || restartDialog.open) return;
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
  const manual = isPhysical() && physicalMode === 'score';
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
  if (scorePlayer.value !== 'all') scorePlayer.value = String(game.activeIndex);
  resetTurnControls();
  renderGame();
  get(game.finished ? 'results-title' : 'turn-title').focus();
  window.scrollTo(0, 0);
  scheduleComputer();
}

function setPhysicalMode(mode) {
  physicalMode = mode;
  selectedCategory = null;
  showScoreFeedback('');
  renderTurn();
  renderChoices();
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
get('play-again').addEventListener('click', showSetup);
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
get('physical-dice-mode').addEventListener('click', () => setPhysicalMode('dice'));
get('physical-score-mode').addEventListener('click', () => setPhysicalMode('score'));
scorePlayer.addEventListener('change', renderScorecard);
scoreInput.addEventListener('input', () => {
  showScoreFeedback('');
  renderChoices();
});
get('score-action').addEventListener('submit', event => {
  event.preventDefault();
  recordScore();
});
get('continue-turn').addEventListener('click', nextTurn);

document.addEventListener('keydown', event => {
  if (board.hidden || rulesDialog.open || restartDialog.open || game.finished || game.pendingRoll
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
