import assert from "node:assert/strict";
import test from "node:test";
import { Game, bonus, categories, categoryCount, parseDice, scoreDice, total, upperTotal } from "../docs/game.js";

const seed = [0x137ba462, 0xfedcba98, 0x47198306, 0xf5431210];
const player = { name: "Player 1" };
const computer = { name: "Computer", computer: true };

test("the six-dice scorecard scores distinct groups, straights and Super-Yatzy", () => {
  const pairs = scoreDice([6, 4, 2, 2, 4, 6]);
  assert.deepEqual(pairs.slice(6, 12), [12, 20, 24, 0, 0, 0]);
  const triples = scoreDice([5, 5, 5, 6, 6, 6]);
  assert.equal(triples[11], 33);
  assert.equal(triples[15], 28);
  const sixes = scoreDice([6, 6, 6, 6, 6, 6]);
  assert.equal(sixes[7], 0, "six of a kind cannot count as two distinct pairs");
  assert.equal(sixes[15], 0, "the full house requires two distinct faces");
  assert.equal(sixes[17], 136);
  assert.deepEqual(scoreDice([1, 2, 3, 4, 5, 6]).slice(12, 15), [15, 20, 30]);
  assert.deepEqual(scoreDice([1, 2, 3, 4, 5, 5]).slice(12, 15), [15, 0, 0]);

  const card = [...Array.from({ length: 6 }, (_, index) => (index + 1) * 4), ...Array(12).fill(null)];
  assert.equal(upperTotal(card), 84);
  assert.equal(bonus(card), 50);
  assert.equal(total(card), 134);
  card[0] = 3;
  assert.equal(bonus(card), 0);
});

test("every category maximum is reachable across all six-dice rolls", () => {
  const maxima = Array(categoryCount).fill(0);
  for (let roll = 0; roll < 6 ** 6; roll++) {
    let encoded = roll;
    const dice = Array.from({ length: 6 }, () => {
      const face = 1 + encoded % 6;
      encoded = Math.floor(encoded / 6);
      return face;
    });
    for (const [category, score] of scoreDice(dice).entries()) {
      maxima[category] = Math.max(maxima[category], score);
    }
  }
  assert.deepEqual(maxima, categories.map(category => category.maximum));
});

test("rolling preserves held dice, enforces three rolls, and records exactly one category per turn", () => {
  const game = new Game([player, { name: "Player 2" }], { seed });
  assert.equal(game.toggleHold(0), false);
  assert.match(game.recordCategory(0), /Roll the dice/);
  const first = game.beginRoll();
  assert.equal(first.number, 1);
  assert.deepEqual(game.dice, first.beforeDice);
  assert.equal(game.beginRoll(), null);
  assert.match(game.recordCategory(0), /wait/);
  assert.equal(game.commitRoll(), true);
  assert.equal(game.toggleHold(0), true);
  assert.equal(game.toggleHold(1), true);
  const saved = game.dice.slice(0, 2);
  assert.equal(game.roll(), true);
  assert.equal(game.roll(), true);
  assert.deepEqual(game.dice.slice(0, 2), saved);
  assert.equal(game.roll(), false);
  assert.equal(game.toggleHold(2), false);
  assert.equal(game.recordCategory(16), null);
  assert.equal(game.lastPoints, game.dice.reduce((sum, die) => sum + die, 0));
  assert.match(game.recordCategory(17), /already complete/);
  assert.equal(game.advanceTurn(), true);
  assert.equal(game.current().name, "Player 2");
  assert.equal(game.round, 1);
  assert.equal(game.rolls, 0);
  assert.equal(game.hasDice(), false);
});

test("physical dice accept six legal values and manual entries require attainable scores", () => {
  const game = new Game([{ ...player, physicalDice: true }], { seed });
  assert.equal(game.roll(), false);
  assert.equal(parseDice("1 2 3 4 5 0"), null);
  assert.equal(parseDice("1 2 3 4 5"), null);
  assert.equal(parseDice("1 2 3 4 5 1 6"), null);
  assert.match(game.setPhysicalDice(new Array(6)), /Enter six dice/);
  assert.match(game.recordCategory(15, 29), /not possible/);
  assert.match(game.recordCategory(5, 31), /not possible/);
  const dice = parseDice(" 2 2 2 5 5 6 ");
  assert.deepEqual(dice, [2, 2, 2, 5, 5, 6]);
  assert.equal(game.setPhysicalDice(dice), null);
  assert.equal(game.recordCategory(15), null);
  assert.equal(game.lastPoints, 16);
  assert.equal(game.advanceTurn(), true);
  assert.match(game.recordCategory(15, 16), /unused/);
  assert.equal(game.recordCategory(5, 0), null);
});

test("counted physical scores are accepted only in a category that can produce them", () => {
  const game = new Game([{ ...player, physicalDice: true }], { seed });
  assert.match(game.recordCategory(13, 15), /not possible/);
  assert.match(game.recordCategory(17, 120), /not possible/);
  assert.equal(game.turnRecorded, false);
  assert.equal(game.recordCategory(17, 130), null);
  assert.equal(game.lastPoints, 130);
  assert.equal(game.advanceTurn(), true);
  assert.equal(game.recordCategory(13, 0), null);
});

test("skipping before or during a computer roll keeps the same score and subsequent dice", () => {
  function enterComputerTurn() {
    const game = new Game([player, computer], { seed });
    assert.equal(game.completeComputerTurn(), false);
    assert.equal(game.roll(), true);
    assert.equal(game.recordCategory(16), null);
    assert.equal(game.advanceTurn(), true);
    return game;
  }

  const reference = enterComputerTurn();
  assert.equal(reference.roll(), true);
  for (;;) {
    const decision = reference.computerDecision();
    if (decision.scoreNow) {
      assert.equal(reference.recordCategory(decision.category), null);
      break;
    }
    assert.equal(reference.applyComputerHolds(decision.keep), true);
    assert.equal(reference.roll(), true);
  }
  const computerCard = reference.current().card;
  const computerDice = reference.dice;
  assert.equal(reference.advanceTurn(), true);
  assert.equal(reference.roll(), true);

  for (const stage of ['start', 'first roll pending', 'holding', 'reroll pending']) {
    const game = enterComputerTurn();
    if (stage !== 'start') assert.ok(game.beginRoll());
    if (stage === 'holding' || stage === 'reroll pending') {
      assert.equal(game.commitRoll(), true);
      const decision = game.computerDecision();
      assert.equal(decision.scoreNow, false);
      assert.equal(game.applyComputerHolds(decision.keep), true);
      if (stage === 'reroll pending') assert.ok(game.beginRoll());
    }
    assert.equal(game.completeComputerTurn(), true, stage);
    assert.deepEqual(game.current().card, computerCard, stage);
    assert.deepEqual(game.dice, computerDice, stage);
    assert.equal(game.completeComputerTurn(), true, stage);
    assert.equal(game.advanceTurn(), true, stage);
    assert.equal(game.current().name, player.name, stage);
    assert.equal(game.round, 2, stage);
    assert.equal(game.roll(), true, stage);
    assert.deepEqual(game.dice, reference.dice, stage);
  }
});

test("default new games with a computer each request fresh browser entropy", t => {
  const words = [seed, [124759, 49477, 3179190, 1271]];
  let seededGames = 0;
  t.mock.method(globalThis.crypto, "getRandomValues", array => {
    assert.equal(array.length, 4);
    array.set(words[seededGames++]);
    return array;
  });
  const players = [player, computer];
  const first = new Game(players);
  const second = new Game(players);
  assert.equal(seededGames, 2);
  const firstRepeat = new Game(players, { seed: words[0] });
  const secondRepeat = new Game(players, { seed: words[1] });
  for (const game of [first, second, firstRepeat, secondRepeat]) assert.equal(game.roll(), true);
  assert.deepEqual(first.dice, firstRepeat.dice);
  assert.deepEqual(second.dice, secondRepeat.dice);
  assert.notDeepEqual(first.dice, second.dice);
});

test("an entire pass-and-play game with the computer fills each category exactly once", () => {
  const game = new Game([player, { name: "Player 2" }, computer], { seed });
  let played = 0;
  while (!game.finished) {
    assert.ok(played < 3 * categoryCount);
    assert.equal(game.round, Math.floor(played / 3) + 1);
    assert.equal(game.activeIndex, played % 3);
    assert.equal(game.roll(), true);
    if (game.current().computer) {
      for (;;) {
        const decision = game.computerDecision();
        assert.ok(decision);
        assert.equal(game.categoryAvailable(decision.category), true);
        assert.equal(decision.points, scoreDice(game.dice)[decision.category]);
        if (decision.scoreNow) {
          assert.equal(game.recordCategory(decision.category), null);
          break;
        }
        assert.equal(game.applyComputerHolds(decision.keep), true);
        const before = [...game.dice];
        assert.equal(game.roll(), true);
        for (let index = 0; index < before.length; index++) {
          if (decision.keep[index]) assert.equal(game.dice[index], before[index]);
        }
      }
    } else {
      assert.equal(game.recordCategory(game.round - 1), null);
    }
    played++;
    assert.equal(game.advanceTurn(), true);
  }
  assert.equal(played, 3 * categoryCount);
  assert.equal(game.roll(), false);
  assert.equal(game.advanceTurn(), false);
  for (const current of game.players) assert.ok(current.card.every(Number.isInteger));
  const best = Math.max(...game.players.map(current => total(current.card)));
  assert.deepEqual(game.winners(), game.players.flatMap((current, index) => total(current.card) === best ? [index] : []));
});

test("equal final scores share the win", () => {
  const game = new Game([
    { name: "Player 1", physicalDice: true },
    { name: "Player 2", physicalDice: true },
  ], { seed });
  for (let round = 0; round < categoryCount; round++) {
    for (let index = 0; index < 2; index++) {
      assert.equal(game.recordCategory(round, 0), null);
      assert.equal(game.advanceTurn(), true);
    }
  }
  assert.deepEqual(game.winners(), [0, 1]);
});
