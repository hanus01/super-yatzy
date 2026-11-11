#pragma once
// Super-Yatzy rules and turn engine, shared by the desktop app and its tests.
// C++26: uses structured-binding conditions and charconv success checks.
#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <cctype>
#include <cstdint>
#include <numeric>
#include <optional>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

using namespace std;

namespace yatzy {

constexpr int diceCount = 6, categoryCount = 18;
using Dice = array<int, diceCount>;
using Counts = array<int, 6>; // Counts of faces 1, 2, ..., 6.
using Scores = array<int, categoryCount>;
using Card = array<optional<int>, categoryCount>;

struct Category { string_view name; int maximum; };
constexpr array<Category, categoryCount> categories{{
    {"Ones", 6}, {"Twos", 12}, {"Threes", 18},
    {"Fours", 24}, {"Fives", 30}, {"Sixes", 36},
    {"One pair", 12}, {"Two pairs", 22}, {"Three pairs", 30},
    {"Three of a kind", 18}, {"Four of a kind", 24}, {"Two triples", 33},
    {"Low straight (1-5)", 15}, {"High straight (2-6)", 20},
    {"Full straight (1-6)", 30}, {"Full house (3+2)", 28},
    {"Chance", 36}, {"Super-Yatzy", 136}
}};

inline Counts countDice(const Dice& dice) {
    Counts counts{};
    for (int face : dice) ++counts[face - 1];
    return counts;
}

inline int diceSum(const Counts& counts) {
    int sum = 0;
    for (int i = 0; i < 6; ++i) sum += (i + 1) * counts[i];
    return sum;
}

inline Scores scoreDice(const Counts& counts) {
    Scores score{};
    vector<int> pairs;
    for (int face = 6; face >= 1; --face) {
        const int n = counts[face - 1];
        score[face - 1] = face * n;
        if (n >= 2) pairs.push_back(2 * face);
        if (n >= 3) score[9] = max(score[9], 3 * face);
        if (n >= 4) score[10] = max(score[10], 4 * face);
        if (n == 6) score[17] = 100 + 6 * face;
    }
    // Each pair must have a different face; higher groups can supply a pair.
    for (int n = 1; n <= 3; ++n)
        if (static_cast<int>(pairs.size()) >= n)
            score[5 + n] = accumulate(pairs.begin(), pairs.begin() + n, 0);

    for (int a = 1; a <= 6; ++a)
        for (int b = 1; b <= 6; ++b)
            if (a != b && counts[a - 1] >= 3) {
                if (counts[b - 1] >= 3)
                    score[11] = max(score[11], 3 * a + 3 * b);
                if (counts[b - 1] >= 2)
                    score[15] = max(score[15], 3 * a + 2 * b);
            }

    const auto present = [&](int first, int last) {
        for (int face = first; face <= last; ++face)
            if (counts[face - 1] == 0) return false;
        return true;
    };
    score[12] = present(1, 5) ? 15 : 0;
    score[13] = present(2, 6) ? 20 : 0;
    score[14] = present(1, 6) ? 30 : 0; // Printed value on your scorecard.
    score[16] = diceSum(counts);
    return score;
}

inline int upperTotal(const Card& card) {
    int sum = 0;
    for (int i = 0; i < 6; ++i) sum += card[i].value_or(0);
    return sum;
}

inline int bonus(const Card& card) { return upperTotal(card) >= 84 ? 50 : 0; }

inline int total(const Card& card) {
    int sum = bonus(card);
    for (const auto& score : card) sum += score.value_or(0);
    return sum;
}

// All 462 unordered six-dice hands and all 924 possible kept-dice groups.
// Multinomial probabilities account for the different ordered ways to roll a hand.
inline int key(const Counts& counts) {
    int result = 0;
    for (int n : counts) result = 7 * result + n;
    return result;
}

inline void enumerateCounts(int face, int left, Counts counts, vector<Counts>& out) {
    if (face == 5) {
        counts[5] = left;
        out.push_back(counts);
        return;
    }
    for (int n = 0; n <= left; ++n) {
        counts[face] = n;
        enumerateCounts(face + 1, left - n, counts, out);
    }
}

struct Edge { int state; double probability; };
struct Policy {
    array<vector<double>, 3> value;
    array<vector<int>, 3> keep;
};

struct DiceModel {
    vector<Counts> hands, holds;
    vector<int> index = vector<int>(117649, -1); // 7^6.
    vector<Scores> scores;
    vector<vector<Edge>> transitions;
    vector<vector<int>> legalHolds;
    array<array<bool, 137>, categoryCount> attainable{};
    array<double, categoryCount> futureValue{};

    DiceModel() {
        array<vector<Counts>, 7> outcomes;
        for (int n = 0; n <= 6; ++n) {
            enumerateCounts(0, n, Counts{}, outcomes[n]);
            holds.insert(holds.end(), outcomes[n].begin(), outcomes[n].end());
        }
        hands = outcomes[6];
        for (int s = 0; s < static_cast<int>(hands.size()); ++s) {
            index[key(hands[s])] = s;
            scores.push_back(scoreDice(hands[s]));
            for (int c = 0; c < categoryCount; ++c) {
                attainable[c][0] = true; // Any category may be scratched.
                attainable[c][scores.back()[c]] = true;
            }
        }
        constexpr array factorial{1, 1, 2, 6, 24, 120, 720};
        for (const auto& held : holds) {
            transitions.emplace_back();
            const int n = 6 - accumulate(held.begin(), held.end(), 0);
            for (const auto& rolled : outcomes[n]) {
                Counts combined{};
                double probability = factorial[n] / pow(6.0, n);
                for (int face = 0; face < 6; ++face) {
                    combined[face] = held[face] + rolled[face];
                    probability /= factorial[rolled[face]];
                }
                transitions.back().push_back({index[key(combined)], probability});
            }
        }
        for (const auto& hand : hands) {
            legalHolds.emplace_back();
            for (int h = 0; h < static_cast<int>(holds.size()); ++h) {
                bool possible = true;
                for (int f = 0; f < 6; ++f)
                    if (holds[h][f] > hand[f]) possible = false;
                if (possible) legalHolds.back().push_back(h);
            }
        }
        // Opportunity cost: expected score on a future turn dedicated to this row.
        for (int c = 0; c < categoryCount; ++c) {
            vector<double> terminal;
            for (const auto& score : scores) terminal.push_back(score[c]);
            const auto policy = solve(terminal);
            for (const auto& edge : transitions[0])
                futureValue[c] += edge.probability * policy.value[2][edge.state];
        }
    }

    Policy solve(const vector<double>& terminal) const {
        Policy policy;
        policy.value[0] = terminal;
        for (int rollsLeft = 1; rollsLeft <= 2; ++rollsLeft) {
            vector<double> expected(holds.size(), 0.0);
            for (int h = 0; h < static_cast<int>(holds.size()); ++h)
                for (const auto& edge : transitions[h])
                    expected[h] += edge.probability * policy.value[rollsLeft - 1][edge.state];
            for (int s = 0; s < static_cast<int>(hands.size()); ++s) {
                int best = legalHolds[s].front();
                for (int h : legalHolds[s])
                    // Holds are ordered by size: ties favor keeping more dice.
                    if (expected[h] >= expected[best] - 1e-10) best = h;
                policy.value[rollsLeft].push_back(expected[best]);
                policy.keep[rollsLeft].push_back(best);
            }
        }
        return policy;
    }
};

// A heuristic for the future upper bonus: assume each unfilled upper row will
// average four matching dice, with uncertainty of 1.2 dice. This is an estimate,
// not a claim of optimal full-game play. Earned/impossible bonuses are exact.
inline double bonusPotential(const Card& card) {
    const int sum = upperTotal(card);
    if (sum >= 84) return 50.0;
    int maximum = sum;
    double mean = sum, variance = 0.0;
    for (int i = 0; i < 6; ++i)
        if (!card[i]) {
            maximum += 6 * (i + 1);
            mean += 4 * (i + 1);
            variance += 1.44 * (i + 1) * (i + 1);
        }
    if (maximum < 84 || variance == 0.0) return 0.0;
    return 25.0 * erfc((83.5 - mean) / sqrt(2.0 * variance));
}

struct ComputerPlan {
    Policy policy;
    vector<int> category;

    ComputerPlan(const DiceModel& model, const Card& card) {
        const double oldBonus = bonusPotential(card);
        vector<double> terminal;
        for (const auto& scores : model.scores) {
            double bestValue = -1e9;
            int bestCategory = -1;
            for (int c = 0; c < categoryCount; ++c)
                if (!card[c]) {
                    double value = scores[c] - model.futureValue[c];
                    if (c < 6) {
                        auto after = card;
                        after[c] = scores[c];
                        value += bonusPotential(after) - oldBonus;
                    }
                    if (value > bestValue + 1e-10) {
                        bestValue = value;
                        bestCategory = c;
                    }
                }
            terminal.push_back(bestValue);
            category.push_back(bestCategory);
        }
        policy = model.solve(terminal);
    }
};


inline string trim(string text) {
    const auto first = text.find_first_not_of(" \t\r\n");
    return first == string::npos ? "" : text.substr(first, text.find_last_not_of(" \t\r\n") - first + 1);
}

inline optional<int> parseInteger(string_view text) {
    if (text.empty()) return nullopt;
    int value{};
    if (auto [end, error [[maybe_unused]]] = from_chars(text.data(), text.data() + text.size(), value))
        if (end == text.data() + text.size()) return value;
    return nullopt;
}

inline optional<Dice> parseDice(const string& text) {
    istringstream input(text);
    Dice dice{};
    string token;
    for (int& face : dice) {
        if (!(input >> token)) return nullopt;
        const auto value = parseInteger(token);
        if (!value || *value < 1 || *value > 6) return nullopt;
        face = *value;
    }
    if (input >> token) return nullopt;
    return dice;
}

inline bool validDice(const Dice& dice) {
    return ranges::all_of(dice, [](int face) { return face >= 1 && face <= 6; });
}

inline mt19937 makeGenerator() {
    random_device source;
    seed_seq seed{source(), source(), source(), source(), source(), source()};
    return mt19937(seed);
}

struct Player {
    string name;
    bool computer = false;
    bool physicalDice = true;
    Card card{};
};

struct RollAnimation {
    Dice beforeDice{};
    Dice afterDice{};
    array<bool, diceCount> moving{};
    int number = 0;
};

struct ComputerDecision {
    array<bool, diceCount> keep{};
    int category = -1;
    int points = 0;
    bool scoreNow = false;
};

// Rendering owns animation timing. beginRoll generates a target without changing
// the visible dice; commitRoll publishes it when the animation has finished.
// A recorded turn stays on screen until advanceTurn is explicitly called.
class Game {
public:
    const DiceModel& model;
    vector<Player> players;
    size_t activeIndex = 0;
    int round = 1;
    Dice dice{1, 1, 1, 1, 1, 1};
    array<bool, diceCount> held{};
    int rolls = 0;
    bool finished = false;
    bool turnRecorded = false;
    bool physicalDiceEntered = false;
    optional<RollAnimation> pendingRoll;
    int lastCategory = -1;
    int lastPoints = 0;

    Game(const DiceModel& diceModel, vector<Player> configuredPlayers,
         mt19937 generator = makeGenerator())
        : model(diceModel), players(std::move(configuredPlayers)), generator_(std::move(generator)) {
        if (players.empty() || players.size() > 9)
            throw invalid_argument("Please choose between one and nine players.");
        for (const auto& player : players)
            if (trim(player.name).empty())
                throw invalid_argument("Every player needs a name.");
    }

    Game(const DiceModel& diceModel, vector<Player> configuredPlayers, uint32_t seed)
        : Game(diceModel, std::move(configuredPlayers), mt19937(seed)) {}

    Player& current() { return players.at(activeIndex); }
    const Player& current() const { return players.at(activeIndex); }

    bool hasDice() const {
        return current().physicalDice && !current().computer
            ? physicalDiceEntered : rolls > 0;
    }

    bool categoryAvailable(int category) const {
        return category >= 0 && category < categoryCount
            && !current().card[category].has_value();
    }

    bool canRoll() const {
        if (finished || turnRecorded || pendingRoll || rolls >= 3) return false;
        if (current().physicalDice && !current().computer) return false;
        return rolls == 0 || !ranges::all_of(held, [](bool value) { return value; });
    }

    bool toggleHold(int index) {
        if (index < 0 || index >= diceCount || finished || turnRecorded || pendingRoll
            || rolls == 0 || rolls >= 3 || current().computer || current().physicalDice)
            return false;
        held[index] = !held[index];
        return true;
    }

    optional<RollAnimation> beginRoll() {
        if (!canRoll()) return nullopt;
        RollAnimation animation{dice, dice, {}, rolls + 1};
        uniform_int_distribution<int> die(1, 6);
        for (int i = 0; i < diceCount; ++i) {
            animation.moving[i] = rolls == 0 || !held[i];
            if (animation.moving[i]) animation.afterDice[i] = die(generator_);
        }
        pendingRoll = animation;
        return animation;
    }

    bool commitRoll() {
        if (!pendingRoll || finished || turnRecorded) return false;
        dice = pendingRoll->afterDice;
        rolls = pendingRoll->number;
        pendingRoll.reset();
        return true;
    }

    // Returns an error message on invalid input, or nullopt after success.
    optional<string> setPhysicalDice(const Dice& finalDice) {
        if (finished || turnRecorded || pendingRoll)
            return "This turn is already complete.";
        if (!current().physicalDice || current().computer)
            return "This player uses the computer's dice.";
        if (!validDice(finalDice)) return "Each die must be between 1 and 6.";
        dice = finalDice;
        physicalDiceEntered = true;
        return nullopt;
    }

    Scores candidateScores() const {
        return hasDice() ? scoreDice(countDice(dice)) : Scores{};
    }

    optional<string> recordCategory(int category, optional<int> physicalManualScore = nullopt) {
        if (finished || turnRecorded) return "This turn is already complete.";
        if (pendingRoll) return "Please wait for the dice to stop.";
        if (!categoryAvailable(category)) return "Please choose an unused category.";
        const bool physical = current().physicalDice && !current().computer;
        int points = 0;
        if (physicalManualScore) {
            if (!physical) return "Scores for computer dice are calculated automatically.";
            points = *physicalManualScore;
            if (points < 0 || points > categories[category].maximum
                || !model.attainable[category][points])
                return "That score is not possible in this category. Enter 0 to scratch it.";
        } else {
            if (!hasDice())
                return physical ? "Enter your final six dice or enter a score."
                                : "Roll the dice before choosing a category.";
            points = scoreDice(countDice(dice))[category];
        }
        current().card[category] = points;
        lastCategory = category;
        lastPoints = points;
        turnRecorded = true;
        return nullopt;
    }

    bool advanceTurn() {
        if (finished || !turnRecorded || pendingRoll) return false;
        ++activeIndex;
        if (activeIndex == players.size()) {
            activeIndex = 0;
            ++round;
        }
        if (round > categoryCount) {
            round = categoryCount;
            finished = true;
            return true;
        }
        dice = Dice{1, 1, 1, 1, 1, 1};
        held.fill(false);
        rolls = 0;
        turnRecorded = false;
        physicalDiceEntered = false;
        lastCategory = -1;
        lastPoints = 0;
        computerPlan_.reset();
        return true;
    }

    // Call once after a computer roll. This evaluates all legal keep/reroll
    // choices for the current turn; the future-category value is a heuristic.
    ComputerDecision computerDecision() {
        ComputerDecision decision;
        if (finished || turnRecorded || pendingRoll || !current().computer || rolls == 0)
            return decision;
        if (!computerPlan_) computerPlan_.emplace(model, current().card);
        const int state = model.index[key(countDice(dice))];
        decision.category = computerPlan_->category[state];
        decision.points = model.scores[state][decision.category];
        if (rolls >= 3) {
            decision.keep.fill(true);
            decision.scoreNow = true;
            return decision;
        }
        Counts keep = model.holds[computerPlan_->policy.keep[3 - rolls][state]];
        for (int i = 0; i < diceCount; ++i)
            if (keep[dice[i] - 1] > 0) {
                decision.keep[i] = true;
                --keep[dice[i] - 1];
            }
        decision.scoreNow = ranges::all_of(decision.keep, [](bool value) { return value; });
        return decision;
    }

    vector<size_t> winners() const {
        vector<size_t> result;
        if (!finished) return result;
        int best = -1;
        for (size_t i = 0; i < players.size(); ++i) {
            const int points = total(players[i].card);
            if (points > best) {
                best = points;
                result.clear();
            }
            if (points == best) result.push_back(i);
        }
        return result;
    }

private:
    mt19937 generator_;
    optional<ComputerPlan> computerPlan_;
};

} // namespace yatzy
