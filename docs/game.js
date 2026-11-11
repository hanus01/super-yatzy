export const diceCount = 6;
export const categories = [
  ["Ones", 6], ["Twos", 12], ["Threes", 18], ["Fours", 24], ["Fives", 30], ["Sixes", 36],
  ["One pair", 12], ["Two pairs", 22], ["Three pairs", 30],
  ["Three of a kind", 18], ["Four of a kind", 24], ["Two triples", 33],
  ["Low straight (1–5)", 15], ["High straight (2–6)", 20],
  ["Full straight (1–6)", 30], ["Full house (3+2)", 28],
  ["Chance", 36], ["Super-Yatzy", 136],
].map(([name, maximum]) => Object.freeze({ name, maximum }));
Object.freeze(categories);
export const categoryCount = categories.length;

function validDice(dice) {
  return Array.isArray(dice) && dice.length === diceCount
    && [...dice].every(face => Number.isInteger(face) && face >= 1 && face <= 6);
}

export function parseDice(text) {
  if (typeof text !== "string") return null;
  const parts = text.trim().split(/\s+/);
  if (!parts.every(part => /^0*[1-6]$/.test(part))) return null;
  const dice = parts.map(Number);
  return validDice(dice) ? dice : null;
}

function countDice(dice) {
  const counts = Array(6).fill(0);
  for (const face of dice) counts[face - 1]++;
  return counts;
}

function scoreCounts(counts) {
  const scores = Array(categoryCount).fill(0);
  const pairs = [];
  for (let face = 6; face >= 1; face--) {
    const count = counts[face - 1];
    scores[face - 1] = face * count;
    scores[16] += face * count;
    if (count >= 2) pairs.push(2 * face);
    if (count >= 3) scores[9] = Math.max(scores[9], 3 * face);
    if (count >= 4) scores[10] = Math.max(scores[10], 4 * face);
    if (count === diceCount) scores[17] = 100 + diceCount * face;
  }
  for (let count = 1; count <= pairs.length; count++) {
    scores[5 + count] = pairs.slice(0, count).reduce((sum, points) => sum + points, 0);
  }
  for (let triple = 1; triple <= 6; triple++) {
    if (counts[triple - 1] < 3) continue;
    for (let other = 1; other <= 6; other++) {
      if (triple === other) continue;
      if (counts[other - 1] >= 2) scores[15] = Math.max(scores[15], 3 * triple + 2 * other);
      if (counts[other - 1] >= 3) scores[11] = Math.max(scores[11], 3 * triple + 3 * other);
    }
  }
  scores[12] = counts.slice(0, 5).every(Boolean) ? 15 : 0;
  scores[13] = counts.slice(1).every(Boolean) ? 20 : 0;
  scores[14] = counts.every(Boolean) ? 30 : 0;
  return scores;
}

export function scoreDice(dice) {
  if (!validDice(dice)) throw new RangeError("Enter six dice, each between 1 and 6.");
  return scoreCounts(countDice(dice));
}

export function upperTotal(card) {
  return card.slice(0, 6).reduce((sum, points) => sum + (points ?? 0), 0);
}
export function bonus(card) { return upperTotal(card) >= 84 ? 50 : 0; }
export function total(card) { return card.reduce((sum, points) => sum + (points ?? 0), bonus(card)); }

function freshSeed() {
  const words = new Uint32Array(4);
  do {
    globalThis.crypto.getRandomValues(words);
  } while (words.every(word => word === 0));
  return words;
}

function makeDie(seed) {
  const words = seed === undefined ? freshSeed() : [...seed];
  if (words.length !== 4 || words.some(word => !Number.isInteger(word) || word < 0 || word > 0xffffffff)
    || words.every(word => word === 0)) {
    throw new RangeError("A test seed must contain four unsigned 32-bit words and cannot be all zero.");
  }
  const state = new Uint32Array(words);
  const rotateLeft = (word, count) => (word << count) | (word >>> (32 - count));

  // xoshiro128**. A game has its own state, independent of animation and other games.
  function nextWord() {
    const value = Math.imul(rotateLeft(Math.imul(state[1], 5), 7), 9) >>> 0;
    const shifted = state[1] << 9;
    state[2] ^= state[0];
    state[3] ^= state[1];
    state[1] ^= state[2];
    state[0] ^= state[3];
    state[2] ^= shifted;
    state[3] = rotateLeft(state[3], 11);
    return value;
  }

  return () => {
    // Discard the four extra uint32 values so all six faces are equally likely.
    let word;
    do {
      word = nextWord();
    } while (word >= 0xfffffffc);
    return 1 + word % 6;
  };
}

function countKey(counts) {
  return counts.reduce((key, count) => 7 * key + count, 0);
}

function enumerateCounts(dice) {
  const outcomes = [];
  const counts = Array(6).fill(0);
  function add(face, remaining) {
    if (face === 5) {
      counts[face] = remaining;
      outcomes.push([...counts]);
      return;
    }
    for (let count = 0; count <= remaining; count++) {
      counts[face] = count;
      add(face + 1, remaining - count);
    }
  }
  add(0, dice);
  return outcomes;
}

// All 462 unordered hands and 924 possible holds. A reroll outcome is weighted
// by the number of ordered rolls that produce it.
class DiceModel {
  constructor() {
    const outcomes = Array.from({ length: 7 }, (_, count) => enumerateCounts(count));
    const hands = outcomes[diceCount];
    this.holds = outcomes.flat();
    this.index = new Int16Array(7 ** 6).fill(-1);
    this.scores = hands.map((hand, index) => {
      this.index[countKey(hand)] = index;
      return scoreCounts(hand);
    });
    this.attainable = categories.map((_, category) =>
      new Set([0, ...this.scores.map(scores => scores[category])]),
    );
    const factorial = [1, 1, 2, 6, 24, 120, 720];
    this.transitions = this.holds.map(hold => {
      const count = diceCount - hold.reduce((sum, value) => sum + value, 0);
      return outcomes[count].map(rolled => {
        let probability = factorial[count] / 6 ** count;
        let key = 0;
        for (let face = 0; face < 6; face++) {
          key = 7 * key + hold[face] + rolled[face];
          probability /= factorial[rolled[face]];
        }
        return { state: this.index[key], probability };
      });
    });
    this.legalHolds = hands.map(hand => {
      const legal = [];
      for (let index = 0; index < this.holds.length; index++) {
        if (this.holds[index].every((count, face) => count <= hand[face])) legal.push(index);
      }
      return legal;
    });
    this.futureValue = categories.map((_, category) => {
      const terminal = this.scores.map(scores => scores[category]);
      const { values } = this.solve(terminal);
      return this.transitions[0].reduce((sum, edge) => sum + edge.probability * values[edge.state], 0);
    });
  }

  solve(terminal) {
    let values = terminal;
    const keeps = [null];
    for (let rerolls = 1; rerolls <= 2; rerolls++) {
      const expected = this.transitions.map(edges =>
        edges.reduce((sum, edge) => sum + edge.probability * values[edge.state], 0),
      );
      const bestHolds = this.legalHolds.map(legal => {
        let best = legal[0];
        for (const hold of legal) {
          // Holds are ordered by size, so ties favor keeping more dice.
          if (expected[hold] >= expected[best] - 1e-10) best = hold;
        }
        return best;
      });
      values = bestHolds.map(hold => expected[hold]);
      keeps.push(bestHolds);
    }
    return { values, keeps };
  }
}

let sharedModel;
function diceModel() { return sharedModel ??= new DiceModel(); }

// Approximation to erfc from Abramowitz and Stegun (7.1.26).
function erfc(value) {
  if (value === 0) return 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(value));
  const polynomial = t * (0.254829592 + t * (-0.284496736 + t *
    (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const tail = polynomial * Math.exp(-value * value);
  return value < 0 ? 2 - tail : tail;
}

// The current turn is solved exactly. Future upper rows are estimated at four
// matching dice per row with a standard deviation of 1.2 dice.
function bonusPotential(card) {
  const sum = upperTotal(card);
  if (sum >= 84) return 50;
  let maximum = sum;
  let mean = sum;
  let variance = 0;
  for (let index = 0; index < 6; index++) {
    if (card[index] !== null) continue;
    const face = index + 1;
    maximum += diceCount * face;
    mean += 4 * face;
    variance += 1.44 * face ** 2;
  }
  if (maximum < 84 || variance === 0) return 0;
  return 25 * erfc((83.5 - mean) / Math.sqrt(2 * variance));
}

function planComputerTurn(model, card) {
  const available = categories.flatMap((_, index) => card[index] === null ? [index] : []);
  const oldBonus = bonusPotential(card);
  const bonusAdjustments = Array.from({ length: 6 }, (_, index) => {
    if (card[index] !== null) return null;
    return Array.from({ length: 7 }, (_, count) => {
      const updated = [...card];
      updated[index] = count * (index + 1);
      return bonusPotential(updated) - oldBonus;
    });
  });
  const bestCategories = [];
  const terminal = model.scores.map(scores => {
    let bestValue = -Infinity;
    let bestCategory = -1;
    for (const category of available) {
      let value = scores[category] - model.futureValue[category];
      if (category < 6) value += bonusAdjustments[category][scores[category] / (category + 1)];
      if (value > bestValue + 1e-10) {
        bestValue = value;
        bestCategory = category;
      }
    }
    bestCategories.push(bestCategory);
    return bestValue;
  });
  return { keeps: model.solve(terminal).keeps, bestCategories };
}

export class Game {
  #die;
  #computerPlan = null;

  constructor(players, { seed } = {}) {
    if (!Array.isArray(players) || players.length < 1 || players.length > 9) {
      throw new RangeError("Please choose between one and nine players.");
    }
    this.players = Array.from(players, player => {
      const name = typeof player?.name === "string" ? player.name.trim() : "";
      if (!name) throw new TypeError("Every player needs a name.");
      return {
        name,
        computer: Boolean(player.computer),
        physicalDice: !player.computer && Boolean(player.physicalDice),
        card: Array(categoryCount).fill(null),
      };
    });
    this.#die = makeDie(seed);
    this.activeIndex = 0;
    this.round = 1;
    this.finished = false;
    this.#resetTurn();
  }

  #resetTurn() {
    this.dice = Array(diceCount).fill(1);
    this.held = Array(diceCount).fill(false);
    this.rolls = 0;
    this.turnRecorded = false;
    this.physicalDiceEntered = false;
    this.pendingRoll = null;
    this.lastCategory = -1;
    this.lastPoints = 0;
    this.#computerPlan = null;
  }

  current() { return this.players[this.activeIndex]; }

  hasDice() { return this.current().physicalDice ? this.physicalDiceEntered : this.rolls > 0; }

  categoryAvailable(category) {
    return Number.isInteger(category) && category >= 0 && category < categoryCount
      && this.current().card[category] === null;
  }

  canRoll() {
    return !this.finished && !this.turnRecorded && !this.pendingRoll && this.rolls < 3
      && !this.current().physicalDice && (this.rolls === 0 || !this.held.every(Boolean));
  }

  toggleHold(index) {
    if (!Number.isInteger(index) || index < 0 || index >= diceCount || this.finished || this.turnRecorded
      || this.pendingRoll || this.rolls === 0 || this.rolls >= 3
      || this.current().computer || this.current().physicalDice) return false;
    this.held[index] = !this.held[index];
    return true;
  }

  beginRoll() {
    if (!this.canRoll()) return null;
    const moving = this.held.map(held => this.rolls === 0 || !held);
    const afterDice = this.dice.map((face, index) => moving[index] ? this.#die() : face);
    this.pendingRoll = {
      beforeDice: [...this.dice], afterDice, moving, number: this.rolls + 1,
    };
    return this.pendingRoll;
  }

  commitRoll() {
    if (!this.pendingRoll || this.finished || this.turnRecorded) return false;
    this.dice = this.pendingRoll.afterDice;
    this.rolls = this.pendingRoll.number;
    this.pendingRoll = null;
    return true;
  }

  roll() { return Boolean(this.beginRoll() && this.commitRoll()); }

  setPhysicalDice(dice) {
    if (this.finished || this.turnRecorded || this.pendingRoll) return "This turn is already complete.";
    if (!this.current().physicalDice) return "This player uses digital dice.";
    if (!validDice(dice)) return "Enter six dice, each between 1 and 6.";
    this.dice = [...dice];
    this.physicalDiceEntered = true;
    return null;
  }

  candidateScores() {
    return this.hasDice() ? scoreCounts(countDice(this.dice)) : Array(categoryCount).fill(0);
  }

  recordCategory(category, manualScore = null) {
    if (this.finished || this.turnRecorded) return "This turn is already complete.";
    if (this.pendingRoll) return "Please wait for the dice to stop.";
    if (!this.categoryAvailable(category)) return "Please choose an unused category.";
    const player = this.current();
    let points;
    if (manualScore !== null) {
      if (!player.physicalDice) return "Scores for digital dice are calculated automatically.";
      if (!Number.isInteger(manualScore) || manualScore < 0 || manualScore > categories[category].maximum
        || !diceModel().attainable[category].has(manualScore)) {
        return "That score is not possible in this category. Enter 0 to scratch it.";
      }
      points = manualScore;
    } else {
      if (!this.hasDice()) {
        return player.physicalDice ? "Enter your final six dice or enter a score."
          : "Roll the dice before choosing a category.";
      }
      points = this.candidateScores()[category];
    }
    player.card[category] = points;
    this.lastCategory = category;
    this.lastPoints = points;
    this.turnRecorded = true;
    return null;
  }

  advanceTurn() {
    if (this.finished || !this.turnRecorded || this.pendingRoll) return false;
    if (this.round === categoryCount && this.activeIndex === this.players.length - 1) {
      this.finished = true;
      return true;
    }
    this.activeIndex++;
    if (this.activeIndex === this.players.length) {
      this.activeIndex = 0;
      this.round++;
    }
    this.#resetTurn();
    return true;
  }

  computerDecision() {
    if (this.finished || this.turnRecorded || this.pendingRoll || !this.current().computer || !this.rolls) return null;
    const model = diceModel();
    this.#computerPlan ??= planComputerTurn(model, this.current().card);
    const state = model.index[countKey(countDice(this.dice))];
    const category = this.#computerPlan.bestCategories[state];
    const points = model.scores[state][category];
    if (this.rolls === 3) {
      return { keep: Array(diceCount).fill(true), category, points, scoreNow: true };
    }
    const hold = [...model.holds[this.#computerPlan.keeps[3 - this.rolls][state]]];
    const keep = this.dice.map(face => {
      if (hold[face - 1] === 0) return false;
      hold[face - 1]--;
      return true;
    });
    return { keep, category, points, scoreNow: keep.every(Boolean) };
  }

  applyComputerHolds(keep) {
    if (this.finished || this.turnRecorded || this.pendingRoll || !this.current().computer
      || this.rolls === 0 || this.rolls >= 3 || !Array.isArray(keep) || keep.length !== diceCount
      || [...keep].some(value => typeof value !== "boolean")) return false;
    this.held = [...keep];
    return true;
  }

  winners() {
    if (!this.finished) return [];
    const scores = this.players.map(player => total(player.card));
    const best = Math.max(...scores);
    return scores.flatMap((points, index) => points === best ? [index] : []);
  }
}
