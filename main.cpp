// A native C++26 / SFML 2 desktop interface for Super-Yatzy.
// Build and package on macOS with ./build_macos.sh.
#include "game.hpp"
#include "macos_display.hpp"
#include <SFML/Graphics.hpp>
#ifdef __APPLE__
// SFML 2 uses OpenGL; this readback captures its full Retina framebuffer.
#define GL_SILENCE_DEPRECATION
#endif
#include <SFML/OpenGL.hpp>
#include <filesystem>
#include <functional>
#include <iostream>
#include <memory>

using namespace std;
using namespace yatzy;

namespace desktop {

constexpr float width = 1440, height = 960;
const sf::Color background{239, 239, 231}, paper{255, 253, 246};
const sf::Color ink{46, 55, 48}, muted{119, 122, 110}, green{49, 79, 64};
const sf::Color red{157, 69, 55}, grid{218, 188, 173}, line{224, 225, 214};
const sf::Color paleGreen{232, 239, 226}, paleRed{247, 231, 217};

sf::Color mix(sf::Color a, sf::Color b, float t) {
    const auto part = [t](int x, int y) { return static_cast<sf::Uint8>(x + (y - x) * t); };
    return {part(a.r,b.r), part(a.g,b.g), part(a.b,b.b), part(a.a,b.a)};
}

void rounded(sf::RenderTarget& target, sf::FloatRect box, float radius,
             sf::Color fill, sf::Color border = sf::Color::Transparent, float thickness = 0) {
    sf::ConvexShape shape(36);
    constexpr float pi = 3.14159265359f;
    const array<sf::Vector2f, 4> corners{{
        {box.left + box.width - radius, box.top + radius},
        {box.left + box.width - radius, box.top + box.height - radius},
        {box.left + radius, box.top + box.height - radius},
        {box.left + radius, box.top + radius}
    }};
    for (int c = 0; c < 4; ++c)
        for (int i = 0; i <= 8; ++i) {
            const float angle = (-90.f + c * 90.f + i * 90.f / 8.f) * pi / 180.f;
            shape.setPoint(c * 9 + i, corners[c] + sf::Vector2f(cos(angle), sin(angle)) * radius);
        }
    shape.setFillColor(fill);
    shape.setOutlineColor(border);
    shape.setOutlineThickness(thickness);
    target.draw(shape);
}

struct Button {
    sf::FloatRect rect;
    bool enabled;
    function<void()> action;
};
struct Field { string id; sf::FloatRect rect; };
enum class Style { Primary, Secondary, Quiet, Red };

// SFML 2 keeps Cocoa event coordinates in points. Rendering uses the actual
// backing pixels, which are typically twice as dense on a Retina display.
class RetinaWindow : public sf::RenderWindow {
    sf::Vector2u drawable{};
public:
    bool refreshDrawable() {
        const auto size = macos_display::drawableSize(getSystemHandle());
        const auto next = size.width && size.height
            ? sf::Vector2u(size.width,size.height) : sf::RenderWindow::getSize();
        const bool changed = drawable != next;
        drawable = next;
        return changed;
    }

    sf::Vector2u getSize() const override {
        return drawable.x && drawable.y ? drawable : sf::RenderWindow::getSize();
    }

    sf::Vector2f pointToCoords(sf::Vector2i point) const {
        const auto points = macos_display::logicalSize(getSystemHandle());
        const auto fallback = sf::RenderWindow::getSize();
        const float w = static_cast<float>(points.width ? points.width : fallback.x);
        const float h = static_cast<float>(points.height ? points.height : fallback.y);
        const auto pixels = getSize();
        return mapPixelToCoords({static_cast<int>(lround(point.x*pixels.x/max(1.f,w))),
                                 static_cast<int>(lround(point.y*pixels.y/max(1.f,h)))});
    }

    bool saveFrame(const string& path) {
        if (!setActive(true)) return false;
        const auto size = getSize();
        vector<sf::Uint8> pixels(static_cast<size_t>(size.x)*size.y*4);
        glPixelStorei(GL_PACK_ALIGNMENT,1);
        glReadPixels(0,0,size.x,size.y,GL_RGBA,GL_UNSIGNED_BYTE,pixels.data());
        sf::Image image;
        image.create(size.x,size.y,pixels.data());
        image.flipVertically();
        return image.saveToFile(path);
    }
};

class App {
    friend struct AppSmokeTest;
    RetinaWindow window;
    sf::Font regular, bold, serif;
    sf::Clock clock;
    DiceModel model;
    unique_ptr<Game> game;
    vector<Button> buttons;
    vector<Field> fields;
    sf::Vector2f mouse{-1,-1};
    array<string,8> names{"Player 1", "Player 2", "Player 3", "Player 4", "Player 5", "Player 6", "Player 7", "Player 8"};
    array<bool,8> ownDice{true,true,true,true,true,true,true,true};
    int humans = 1, selected = -1, playerPage = 0;
    bool includeComputer = true, setup = true, rules = false, confirmNew = false;
    bool result = false, manual = false, aiRerollQueued = false;
    bool selectAllText = false;
    string activeField, diceInput, pointInput, feedback, aiMessage;
    bool error = false;
    optional<RollAnimation> animation;
    double animationStart = 0, aiAt = 0;
    string capturePath;
    int frames = 0;
    float pixelsPerUnit = 1.f;

public:
    App(bool preview, string capture) : capturePath(std::move(capture)) {
        if (!regular.loadFromFile("/System/Library/Fonts/Supplemental/Arial.ttf"))
            if (!regular.loadFromFile("/System/Library/Fonts/Helvetica.ttc"))
                throw runtime_error("A system font could not be loaded.");
        if (!bold.loadFromFile("/System/Library/Fonts/Supplemental/Arial Bold.ttf")) bold = regular;
        if (!serif.loadFromFile("/System/Library/Fonts/Supplemental/Georgia Bold.ttf")) serif = bold;
        sf::ContextSettings settings;
        settings.antialiasingLevel = 8;
        const auto screen = sf::VideoMode::getDesktopMode();
        const unsigned w = min(1440u, screen.width > 100 ? screen.width - 70 : screen.width);
        const unsigned h = min(960u, screen.height > 150 ? screen.height - 100 : screen.height);
        window.create(sf::VideoMode(w,h), "Super Yatzy", sf::Style::Default, settings);
        macos_display::enableRetina(window.getSystemHandle());
        macos_display::fitWindowToScreen(window.getSystemHandle(),width,height);
        window.setFramerateLimit(60);
        resize();
        if (preview) makePreview();
    }

    int run() {
        while (window.isOpen()) {
            if (window.refreshDrawable()) resize();
            sf::Event event{};
            while (window.pollEvent(event)) handle(event);
            if (!window.isOpen()) break;
            update();
            draw();
            if (!capturePath.empty() && ++frames >= 4) {
                if (!window.saveFrame(capturePath))
                    throw runtime_error("Could not save the window preview.");
                window.close();
            } else window.display();
        }
        return 0;
    }

private:
    double now() const { return clock.getElapsedTime().asSeconds(); }

    void resize() {
        window.refreshDrawable();
        const auto size = window.getSize();
        if (!size.x || !size.y) return;
        sf::View view(sf::FloatRect(0,0,width,height));
        const float ratio = static_cast<float>(size.x) / size.y;
        const float wanted = width / height;
        if (ratio > wanted) {
            const float fraction = wanted / ratio;
            view.setViewport({(1-fraction)/2,0,fraction,1});
        } else {
            const float fraction = ratio / wanted;
            view.setViewport({0,(1-fraction)/2,1,fraction});
        }
        window.setView(view);
        const auto viewport = window.getViewport(view);
        pixelsPerUnit = max(1.f,min(viewport.width/width,viewport.height/height));
    }

    sf::Text label(const string& value, unsigned size, sf::Color color,
                   bool heavy = false, const sf::Font* customFont = nullptr) const {
        const unsigned rasterSize = max(size,static_cast<unsigned>(ceil(size*pixelsPerUnit)));
        const sf::Font& font = customFont ? *customFont : heavy ? bold : regular;
        sf::Text text(sf::String::fromUtf8(value.begin(), value.end()),font,rasterSize);
        const float inverse = static_cast<float>(size)/rasterSize;
        text.setScale(inverse,inverse);
        text.setFillColor(color);
        return text;
    }

    sf::Vector2f snap(float x, float y) const {
        return window.mapPixelToCoords(window.mapCoordsToPixel({x,y}));
    }

    void text(const string& value, float x, float y, unsigned size = 16,
              sf::Color color = ink, bool heavy = false) {
        auto item = label(value,size,color,heavy);
        item.setPosition(snap(x,y));
        window.draw(item);
    }

    string fit(string value, float available, unsigned size, bool heavy = false) const {
        if (label(value,size,ink,heavy).getGlobalBounds().width <= available) return value;
        while (!value.empty()) {
            size_t at = value.size()-1;
            while (at > 0 && (static_cast<unsigned char>(value[at]) & 0xc0) == 0x80) --at;
            value.erase(at);
            if (label(value + "...",size,ink,heavy).getGlobalBounds().width <= available) break;
        }
        return value + "...";
    }

    void centered(const string& value, sf::FloatRect rect, unsigned size = 15,
                  sf::Color color = ink, bool heavy = false) {
        auto item = label(fit(value,rect.width-12,size,heavy),size,color,heavy);
        const auto bounds = item.getGlobalBounds();
        item.setPosition(snap(rect.left+(rect.width-bounds.width)/2-bounds.left,
                              rect.top+(rect.height-bounds.height)/2-bounds.top));
        window.draw(item);
    }

    float wrapped(const string& value, float x, float y, float available,
                  unsigned size = 16, sf::Color color = muted, float spacing = 25) {
        istringstream stream(value);
        string word, current;
        while (stream >> word) {
            if (!current.empty() && label(current + " " + word,size,color).getGlobalBounds().width > available) {
                text(current,x,y,size,color);
                y += spacing;
                current = word;
            } else current += (current.empty() ? "" : " ") + word;
        }
        if (!current.empty()) { text(current,x,y,size,color); y += spacing; }
        return y;
    }

    void panel(sf::FloatRect rect, sf::Color fill = paper) {
        rounded(window,{rect.left,rect.top+5,rect.width,rect.height},15,{33,48,36,9});
        rounded(window,rect,15,fill,{222,223,211},1);
    }

    void ruleLine(float x, float y, float w, sf::Color color = line) {
        sf::RectangleShape shape({w,1});
        shape.setPosition(x,y); shape.setFillColor(color); window.draw(shape);
    }

    void hit(sf::FloatRect rect, bool enabled, function<void()> action) {
        buttons.push_back({rect,enabled,std::move(action)});
    }

    void button(sf::FloatRect rect, const string& title, function<void()> action,
                Style style = Style::Secondary, bool enabled = true) {
        const bool over = rect.contains(mouse);
        sf::Color fill = style == Style::Primary ? green : style == Style::Red ? red
            : style == Style::Quiet ? sf::Color::Transparent : sf::Color(243,243,234);
        sf::Color color = style == Style::Primary || style == Style::Red ? paper : ink;
        sf::Color border = style == Style::Quiet ? sf::Color::Transparent : line;
        if (enabled && over) fill = mix(fill,style == Style::Quiet ? paleGreen : ink,.08f);
        if (!enabled) { fill = {234,234,225}; color = {157,160,148}; }
        rounded(window,rect,9,fill,border,style == Style::Primary || style == Style::Red ? 0 : 1);
        centered(title,rect,15,color,true);
        hit(rect,enabled,std::move(action));
    }

    string& fieldValue(const string& id) {
        if (id == "dice") return diceInput;
        if (id == "points") return pointInput;
        return names.at(static_cast<size_t>(stoi(id.substr(4))));
    }

    void input(const string& id, sf::FloatRect rect, const string& placeholder, bool enabled = true) {
        const bool focused = activeField == id;
        rounded(window,rect,8,enabled ? sf::Color(255,255,250) : sf::Color(239,240,231),
                focused ? green : line,focused ? 2 : 1);
        const auto& value = fieldValue(id);
        if (focused && selectAllText && !value.empty())
            rounded(window,{rect.left+10,rect.top+10,
                min(rect.width-20,label(fit(value,rect.width-24,16),16,ink).getGlobalBounds().width+7),25},3,paleGreen);
        text(fit(value.empty() ? placeholder : value,rect.width-24,16),
             rect.left+12,rect.top+12,16,value.empty() ? muted : ink);
        if (focused && !selectAllText && fmod(now(),1.0) < .5) {
            const float advance = label(fit(value,rect.width-26,16),16,ink).getGlobalBounds().width;
            sf::RectangleShape caret({1,20}); caret.setPosition(rect.left+13+advance,rect.top+13);
            caret.setFillColor(green); window.draw(caret);
        }
        if (enabled) fields.push_back({id,rect});
    }

    void message(string value, bool bad = false) {
        feedback = std::move(value); error = bad;
    }

    bool physical() const { return game && game->current().physicalDice && !game->current().computer; }
    bool busy() const { return animation.has_value(); }
    bool humanCanChoose() const {
        return game && !game->finished && !game->turnRecorded && !game->current().computer && !busy();
    }

    optional<int> previewPoints(int c) const {
        if (!game || !game->categoryAvailable(c)) return nullopt;
        if (physical() && manual) {
            if (c != selected) return nullopt;
            const auto value = parseInteger(trim(pointInput));
            if (!value || *value < 0 || *value > categories[c].maximum || !model.attainable[c][*value]) return nullopt;
            return value;
        }
        if (physical()) {
            const auto dice = parseDice(diceInput);
            if (dice) return scoreDice(countDice(*dice))[c];
            return nullopt;
        }
        if (!game->hasDice() || busy()) return nullopt;
        return game->candidateScores()[c];
    }

    void selectCategory(int c) {
        if (!humanCanChoose() || !game->categoryAvailable(c)) return;
        selected = c; feedback.clear();
    }

    void applyPhysical() {
        if (!physical() || manual || !humanCanChoose()) return;
        const auto dice = parseDice(diceInput);
        if (!dice) { message("Enter exactly six dice, for example: 2 2 3 4 6 6.",true); return; }
        if (auto problem = game->setPhysicalDice(*dice)) message(*problem,true);
        else { message("Dice checked. Choose a category below."); activeField.clear(); }
    }

    void record() {
        if (!humanCanChoose()) return;
        if (selected < 0) { message("Choose an unused category first.",true); return; }
        optional<string> problem;
        if (physical() && manual) {
            const auto points = parseInteger(trim(pointInput));
            if (!points) { message("Enter a whole-number score, or 0 to scratch.",true); return; }
            problem = game->recordCategory(selected,*points);
        } else {
            if (physical()) {
                const auto dice = parseDice(diceInput);
                if (!dice) { message("Enter your final six dice first.",true); return; }
                if (auto invalid = game->setPhysicalDice(*dice)) { message(*invalid,true); return; }
            }
            problem = game->recordCategory(selected);
        }
        if (problem) message(*problem,true);
        else { activeField.clear(); message("Recorded. Your scorecard is up to date."); }
    }

    void beginAnimation() {
        if (!game) return;
        if (auto roll = game->beginRoll()) {
            animation = roll; animationStart = now(); feedback.clear();
            activeField.clear(); selected = -1;
        }
    }

    void nextTurn() {
        if (!game || !game->advanceTurn()) return;
        selected = -1; diceInput.clear(); pointInput.clear(); feedback.clear();
        aiMessage.clear(); activeField.clear(); manual = false; aiRerollQueued = false;
        playerPage = static_cast<int>(game->activeIndex / 4) * 4;
        aiAt = now() + .8;
        if (game->finished) result = true;
    }

    void startGame() {
        vector<Player> players;
        for (int i = 0; i < humans; ++i) {
            auto name = trim(names[i]);
            if (name.empty()) { message("Please give every player a name.",true); return; }
            players.push_back({name,false,ownDice[i]});
        }
        if (includeComputer) players.push_back({"Computer",true,false});
        game = make_unique<Game>(model,std::move(players));
        setup = false; confirmNew = false; result = false; manual = false;
        selected = -1; playerPage = 0; animation.reset();
        activeField.clear(); diceInput.clear(); pointInput.clear(); feedback.clear();
        aiMessage.clear(); aiRerollQueued = false; aiAt = now()+.8;
    }

    void requestStart() {
        for (int i = 0; i < humans; ++i)
            if (trim(names[i]).empty()) { message("Please give every player a name.",true); return; }
        if (game && !game->finished) confirmNew = true;
        else startGame();
    }

    void handle(const sf::Event& event) {
        if (event.type == sf::Event::Closed) { window.close(); return; }
        if (event.type == sf::Event::Resized) { resize(); return; }
        if (event.type == sf::Event::MouseButtonPressed && event.mouseButton.button == sf::Mouse::Left) {
            mouse = window.pointToCoords({event.mouseButton.x,event.mouseButton.y});
            activeField.clear();
            selectAllText = false;
            for (auto it = fields.rbegin(); it != fields.rend(); ++it)
                if (it->rect.contains(mouse)) { activeField = it->id; return; }
            for (auto it = buttons.rbegin(); it != buttons.rend(); ++it)
                if (it->rect.contains(mouse)) {
                    if (it->enabled) { auto action = it->action; action(); }
                    return;
                }
        }
        if (event.type == sf::Event::TextEntered && !activeField.empty()) {
            auto& value = fieldValue(activeField);
            const auto c = event.text.unicode;
            if (selectAllText && (c == 8 || (c >= 32 && c != 127))) {
                value.clear(); selectAllText = false;
            }
            if (c == 8 && !value.empty()) {
                size_t at = value.size()-1;
                while (at > 0 && (static_cast<unsigned char>(value[at]) & 0xc0) == 0x80) --at;
                value.erase(at);
            } else if (c >= 32 && c != 127 && value.size() < (activeField == "points" ? 8u : 40u)) {
                sf::String item(c); const auto bytes = item.toUtf8();
                value.append(bytes.begin(),bytes.end());
            }
            feedback.clear();
        }
        if (event.type != sf::Event::KeyPressed) return;
        const auto key = event.key.code;
        if (key == sf::Keyboard::Escape) {
            if (confirmNew) confirmNew = false;
            else if (rules) rules = false;
            else if (result) result = false;
            else if (setup && game) setup = false;
            activeField.clear(); return;
        }
        if (rules || confirmNew || result) return;
        if (!activeField.empty()) {
            if ((event.key.system || event.key.control) && key == sf::Keyboard::V) {
                auto bytes = sf::Clipboard::getString().toUtf8();
                string pasted(bytes.begin(),bytes.end());
                erase_if(pasted,[](unsigned char c) { return c < 32 || c == 127; });
                auto& value = fieldValue(activeField);
                if (selectAllText) { value.clear(); selectAllText = false; }
                value += pasted.substr(0,40-min<size_t>(40,value.size()));
            }
            if ((event.key.system || event.key.control) && key == sf::Keyboard::A)
                selectAllText = true;
            if (key == sf::Keyboard::Enter) {
                if (setup) activeField.clear();
                else if (activeField == "dice") applyPhysical();
                else if (activeField == "points") record();
            }
            return;
        }
        if (setup || !game || busy()) return;
        if (key == sf::Keyboard::Enter) {
            if (game->turnRecorded) nextTurn(); else record();
        }
        if (game->current().computer || game->turnRecorded || game->finished) return;
        if (key >= sf::Keyboard::Num1 && key <= sf::Keyboard::Num6)
            game->toggleHold(key-sf::Keyboard::Num1);
        if (key == sf::Keyboard::Space && !physical()) beginAnimation();
    }

    void update() {
        mouse = window.pointToCoords(sf::Mouse::getPosition(window));
        if (!game || setup || rules || confirmNew || result) return;
        if (animation) {
            if (now() - animationStart >= 1.15) {
                game->commitRoll(); animation.reset(); aiAt = now()+.75;
            }
            return;
        }
        if (!game->current().computer || game->finished || game->turnRecorded || now() < aiAt) return;
        if (game->rolls == 0 || aiRerollQueued) {
            aiRerollQueued = false; beginAnimation(); return;
        }
        const auto decision = game->computerDecision();
        selected = decision.category;
        if (decision.scoreNow) {
            if (auto problem = game->recordCategory(decision.category)) message(*problem,true);
            else {
                aiMessage = "A good place to stop.";
                message("Computer recorded " + string(categories[decision.category].name) + " for " + to_string(decision.points) + ".");
            }
        } else {
            game->held = decision.keep;
            const int count = static_cast<int>(ranges::count(decision.keep,true));
            aiMessage = "Keeping " + to_string(count) + "; looking for a better finish.";
            aiRerollQueued = true; aiAt = now()+.9;
        }
    }

    void drawDie(float x, float y, float size, int value, bool kept, float angle = 0, float rise = 0, float scale = 1) {
        rounded(window,{x+3,y+7,size,size},size*.18f,{41,51,39,15});
        const sf::Color fill = kept ? sf::Color(246,251,237) : sf::Color(255,255,250);
        // Dice are drawn directly in a transformed local coordinate system.
        sf::ConvexShape shape(36);
        constexpr float pi = 3.14159265f;
        const float radius = size*.18f;
        const array<sf::Vector2f,4> corners{{{size-radius,radius},{size-radius,size-radius},{radius,size-radius},{radius,radius}}};
        for (int c = 0; c < 4; ++c)
            for (int i = 0; i <= 8; ++i) {
                const float a = (-90.f+c*90.f+i*90.f/8)*pi/180;
                shape.setPoint(c*9+i,corners[c]+sf::Vector2f(cos(a),sin(a))*radius);
            }
        shape.setFillColor(fill); shape.setOutlineThickness(kept ? 2.5f : 1.f);
        shape.setOutlineColor(kept ? green : sf::Color(216,219,205));
        sf::Transform transform;
        transform.translate(x+size/2,y+size/2-rise).rotate(angle).scale(scale,scale).translate(-size/2,-size/2);
        sf::RenderStates states(transform); window.draw(shape,states);
        const auto pip = [&](float px, float py) {
            sf::CircleShape dot(size*.062f,20); dot.setOrigin(size*.062f,size*.062f);
            dot.setPosition(px*size,py*size); dot.setFillColor(kept ? green : ink); window.draw(dot,states);
        };
        if (value % 2) pip(.5f,.5f);
        if (value >= 2) { pip(.27f,.27f); pip(.73f,.73f); }
        if (value >= 4) { pip(.73f,.27f); pip(.27f,.73f); }
        if (value == 6) { pip(.27f,.5f); pip(.73f,.5f); }
    }

    void drawTop() {
        rounded(window,{36,33,44,44},12,green);
        for (auto p : array<sf::Vector2f,3>{{{48,45},{58,55},{68,65}}}) {
            sf::CircleShape dot(3); dot.setPosition(p.x-3,p.y-3); dot.setFillColor(paper); window.draw(dot);
        }
        text("SUPER YATZY",96,35,26,ink,true);
        text("A little luck. A good decision.",97,70,13,muted);
        if (game && !setup) {
            rounded(window,{636,40,184,37},18,paleGreen);
            centered(game->finished ? "FINAL SCORECARD" : "ROUND " + to_string(game->round) + " / 18",{636,40,184,37},12,green,true);
        }
        button({1130,38,100,40},"Rules",[this]{ rules = true; activeField.clear(); },Style::Quiet);
        button({1246,38,158,40},setup ? "Your table" : "New game",[this]{
            setup = true; activeField.clear(); feedback.clear();
        },Style::Secondary,!setup);
        ruleLine(36,105,1368);
        text("SIX DICE. EIGHTEEN POSSIBILITIES.",38,936,10,muted,true);
        if (!setup) text("1-6  Keep dice     SPACE  Roll     ENTER  Record / continue",1000,934,11,muted);
    }

    void drawSetup() {
        panel({240,126,960,792});
        text("MAKE YOURSELF AT HOME",282,160,12,red,true);
        text("Who's at the table?",280,190,36,ink,true);
        text("Choose your players, then decide who brings the dice.",282,243,16,muted);
        text("HUMANS",978,167,11,muted,true);
        button({974,195,44,40},"-",[this]{ humans = max(1,humans-1); activeField.clear(); },Style::Secondary,humans>1);
        centered(to_string(humans),{1024,195,52,40},22,ink,true);
        button({1082,195,44,40},"+",[this]{ humans = min(8,humans+1); },Style::Secondary,humans<8);
        text("PLAYER NAME",284,296,11,muted,true);
        text("DICE",706,296,11,muted,true);
        for (int i = 0; i < humans; ++i) {
            const float y = 324 + 55.f*i;
            centered(to_string(i+1),{278,y,28,44},13,muted,true);
            input("name"+to_string(i),{318,y,358,44},"Player name");
            button({706,y,190,44},"My own dice",[this,i]{ ownDice[i]=true; },ownDice[i] ? Style::Primary : Style::Secondary);
            button({908,y,218,44},"Computer dice",[this,i]{ ownDice[i]=false; },!ownDice[i] ? Style::Primary : Style::Secondary);
        }
        ruleLine(282,783,876);
        button({282,802,260,43},includeComputer ? "[x]  Computer opponent" : "[ ]  Computer opponent",[this]{ includeComputer=!includeComputer; },includeComputer ? Style::Primary : Style::Secondary);
        text("Six dice, up to three rolls. Everyone gets their own scorecard.",558,815,13,muted);
        if (game) button({282,862,166,40},"Back to game",[this]{ setup=false; feedback.clear(); },Style::Quiet);
        if (!feedback.empty()) text(fit(feedback,550,13),game ? 460.f : 284.f,875,13,error ? red : muted);
        button({948,858,178,44},"Let's play",[this]{ requestStart(); },Style::Primary);
    }

    int categoryForRow(int row) const {
        if (row < 6) return row;
        if (row >= 8 && row <= 19) return row-2;
        return -1;
    }

    void drawScorecard() {
        panel({36,126,806,792});
        auto title=label("Super-yatzy",35,red,true,&serif); title.setPosition(snap(61,148)); window.draw(title);
        text("6 DICE",725,160,13,red,true);
        text("THE SCORECARD",63,195,10,muted,true);
        const int shown = min(4,static_cast<int>(game->players.size())-playerPage);
        constexpr float x = 60, tableY = 224, labelW = 258, maxW = 48, tableW = 758, headerH = 36, rowH = 29;
        const float scoreX = x+labelW+maxW, colW = (tableW-labelW-maxW)/shown;
        const int currentCol = static_cast<int>(game->activeIndex)-playerPage;
        rounded(window,{x,tableY,tableW,headerH+rowH*21},0,paper,grid,1);
        if (currentCol >= 0 && currentCol < shown && !game->finished) {
            sf::RectangleShape shade({colW,headerH+rowH*21}); shade.setPosition(scoreX+currentCol*colW,tableY);
            shade.setFillColor({243,245,233}); window.draw(shade);
        }
        text("Category",x+12,tableY+10,13,red,true);
        centered("Max",{x+labelW,tableY,maxW,headerH},12,red,true);
        for (int p = 0; p < shown; ++p) {
            const int id = playerPage+p;
            const auto& player = game->players[id];
            centered(fit(player.name,colW-18,14,true),{scoreX+p*colW,tableY,colW,headerH},14,id==static_cast<int>(game->activeIndex) ? green : ink,true);
            if (id == static_cast<int>(game->activeIndex) && !game->finished)
                ruleLine(scoreX+p*colW+12,tableY+headerH-3,colW-24,green);
        }
        for (int row = 0; row < 21; ++row) {
            const float y = tableY+headerH+row*rowH;
            const int c = categoryForRow(row);
            const bool summary = row == 6 || row == 7 || row == 20;
            if (summary || c == selected) {
                sf::RectangleShape shade({tableW,rowH}); shade.setPosition(x,y);
                shade.setFillColor(row==20 ? sf::Color(242,228,214) : c>=0&&c==selected ? paleGreen : sf::Color(250,242,230));
                window.draw(shade);
            }
            const string name = c>=0 ? string(categories[c].name) : row==6 ? "Upper sum" : row==7 ? "Bonus (84 or more)" : "TOTAL";
            const int maximum = c>=0 ? categories[c].maximum : row==6 ? 126 : row==7 ? 50 : 580;
            text(name,x+12,y+7,summary ? 13 : 14,summary ? red : ink,summary);
            centered(to_string(maximum),{x+labelW,y,maxW,rowH},12,muted);
            for (int p = 0; p < shown; ++p) {
                const auto& player = game->players[playerPage+p];
                string value = "-"; sf::Color color = muted; bool heavy = false;
                if (c >= 0 && player.card[c]) { value=to_string(*player.card[c]); color=ink; heavy=true; }
                else if (c < 0) { value=to_string(row==6 ? upperTotal(player.card) : row==7 ? bonus(player.card) : total(player.card)); color=row==20 ? red : ink; heavy=true; }
                else if (c==selected && playerPage+p==static_cast<int>(game->activeIndex))
                    if (const auto points=previewPoints(c)) { value="("+to_string(*points)+")"; color=green; }
                centered(value,{scoreX+p*colW,y,colW,rowH},row==20 ? 19 : 15,color,heavy);
            }
            ruleLine(x,y+rowH,tableW,summary ? grid : mix(grid,paper,.45f));
            if (c >= 0) hit({x,y,tableW,rowH},humanCanChoose()&&game->categoryAvailable(c),[this,c]{selectCategory(c);});
        }
        for (float vx : {x+labelW,scoreX}) {
            sf::RectangleShape v({1,headerH+rowH*21}); v.setPosition(vx,tableY); v.setFillColor(grid); window.draw(v);
        }
        for (int p = 1; p < shown; ++p) {
            sf::RectangleShape v({1,headerH+rowH*21}); v.setPosition(scoreX+p*colW,tableY); v.setFillColor(grid); window.draw(v);
        }
        ruleLine(x,tableY+headerH,tableW,grid);
        text("A dash is an open category. A zero is a scratch.",64,887,11,muted);
        if (game->players.size()>4) {
            button({626,881,36,27},"<",[this]{playerPage=max(0,playerPage-4);},Style::Quiet,playerPage>0);
            centered(to_string(playerPage+1)+"-"+to_string(playerPage+shown)+" of "+to_string(game->players.size()),{666,881,106,27},11,muted);
            button({780,881,36,27},">",[this]{
                const int lastPage = (static_cast<int>(game->players.size())-1)/4*4;
                playerPage = min(lastPage,playerPage+4);
            },Style::Quiet,playerPage+shown<static_cast<int>(game->players.size()));
        }
    }

    void drawTray() {
        panel({868,126,536,346});
        const auto& player = game->current();
        const string caption = game->finished ? "THE TABLE IS CLOSED" : game->turnRecorded ? "TURN COMPLETE"
            : player.computer ? "COMPUTER'S TURN" : "YOUR TURN";
        text(caption,892,151,11,red,true);
        text(fit(game->finished ? "Well played." : player.name,380,27,true),890,177,27,ink,true);
        if (!game->finished) {
            const string status = physical() ? "Your own dice" : "Roll " + to_string(animation ? animation->number : game->rolls) + " of 3";
            text(status,1243,186,12,muted);
        }
        if (physical() && !game->finished) {
            const bool editable = humanCanChoose();
            button({892,222,228,34},"Enter final dice",[this]{ manual=false; activeField.clear(); feedback.clear(); },manual ? Style::Secondary : Style::Primary,editable);
            button({1130,222,250,34},"Enter score",[this]{ manual=true; activeField="points"; feedback.clear(); },manual ? Style::Primary : Style::Secondary,editable);
            if (manual) {
                input("points",{892,273,184,47},"Points",editable);
                wrapped(selected < 0 ? "Choose a category below, then enter its score. Enter 0 to scratch it."
                    : "Score for " + string(categories[selected].name) + ". Enter 0 to scratch it.",1094,278,282,13,muted,21);
                text(game->turnRecorded ? "Score entered manually. Ready for the next player." : "Your physical dice stay on your table.",892,355,14,muted);
            } else {
                input("dice",{892,273,346,47},"e.g. 2 2 3 4 6 6",editable);
                button({1250,273,130,47},"Check dice",[this]{applyPhysical();},Style::Secondary,editable);
                const auto entered = parseDice(diceInput);
                if (entered)
                    for (int i = 0; i < 6; ++i) drawDie(914+i*77,339,45,(*entered)[i],false);
                else text("Roll up to three times, then enter all six final dice.",892,354,14,muted);
            }
        } else {
            const bool show = game->hasDice();
            text(game->finished ? "Until the next game." : game->turnRecorded ? "One category filled. On to the next player."
                 : player.computer ? (aiMessage.empty() ? "Considering the possibilities..." : aiMessage)
                 : show ? "Click a die to keep it. Click again to release it." : "Your six dice are ready. Let's roll.",892,221,13,muted);
            for (int i = 0; i < 6; ++i) {
                const float x = 892+i*83, y = 273;
                int value = game->dice[i]; float angle=0, rise=0, scale=1;
                bool kept = show && game->held[i];
                if (animation && animation->moving[i]) {
                    const float t = clamp(static_cast<float>((now()-animationStart-i*.025)/.98),0.f,1.f);
                    const float envelope = sin(t*3.14159265f);
                    angle = sin(t*28+i)*20*envelope;
                    rise = abs(sin(t*15+i*.5f))*17*envelope;
                    scale = 1+envelope*.05f;
                    value = t>.94f ? animation->afterDice[i] : (static_cast<int>((now()-animationStart)*26)+i*3)%6+1;
                    kept=false;
                }
                drawDie(x,y,70,show||animation ? value : i+1,kept,angle,rise,scale);
                centered(kept ? "KEPT" : show ? to_string(i+1) : "READY",{x,y+79,70,19},10,kept ? green : muted,kept);
                hit({x-3,y-7,76,105},humanCanChoose()&&show&&!physical()&&game->rolls<3,[this,i]{game->toggleHold(i);});
            }
            const bool editable = humanCanChoose() && !physical();
            const string rollLabel = busy() ? "Rolling..." : game->rolls==0 ? "Roll six dice" : game->rolls>=3 ? "All rolls used" : "Roll again";
            button({892,384,286,42},rollLabel,[this]{beginAnimation();},Style::Primary,editable&&game->canRoll());
            button({1190,384,190,42},"Release all",[this]{game->held.fill(false);},Style::Secondary,editable&&game->rolls>0&&game->rolls<3);
        }
        const int upper = upperTotal(player.card);
        text(upper>=84 ? "UPPER BONUS EARNED  +50" : "UPPER BONUS  " + to_string(upper) + " / 84",892,445,10,upper>=84 ? green : muted,true);
        rounded(window,{1194,448,186,5},2,{226,229,215});
        if (upper>0) rounded(window,{1194,448,186*min(1.f,upper/84.f),5},2,green);
    }

    void drawOptions() {
        panel({868,490,536,428});
        if (game->finished) {
            text("FINAL RESULTS",892,514,11,red,true);
            text("A good game, all round.",892,546,25,ink,true);
            const auto leaders=game->winners();
            float y=597;
            for (size_t i=0;i<game->players.size();++i) {
                const auto& p=game->players[i];
                text(fit(p.name,350,15),896,y,15,ink,ranges::find(leaders,i)!=leaders.end());
                text(to_string(total(p.card)),1316,y,15,green,true); y+=26;
            }
            button({892,850,488,44},"Play another game",[this]{setup=true;feedback.clear();},Style::Primary);
            return;
        }
        text(game->turnRecorded ? "ON THE SCORECARD" : "CHOOSE A CATEGORY",892,514,11,red,true);
        text(game->turnRecorded ? "Your turn has been recorded." : "Select here or click the scorecard.",892,537,13,muted);
        for (int c=0;c<categoryCount;++c) {
            const int column=c/9, row=c%9;
            const sf::FloatRect box{892+column*251.f,568+row*27.f,237,25};
            const bool available=game->categoryAvailable(c), chosen=selected==c;
            if (chosen) rounded(window,box,5,paleGreen);
            else if (available&&box.contains(mouse)&&humanCanChoose()) rounded(window,box,5,{245,245,237});
            text(to_string(c+1),box.left+6,box.top+6,10,chosen ? green : muted);
            text(fit(string(categories[c].name),169,12),box.left+29,box.top+5,12,available ? ink : sf::Color(166,168,156),chosen);
            string points="-";
            if (!available) points=to_string(*game->current().card[c]);
            else if (const auto n=previewPoints(c)) points=to_string(*n);
            centered(points,{box.left+204,box.top,30,25},12,available ? green : muted,true);
            hit(box,humanCanChoose()&&available,[this,c]{selectCategory(c);});
        }
        ruleLine(892,818,488);
        if (game->turnRecorded) {
            text(string(categories[game->lastCategory].name),892,830,14,green,true);
            text("+"+to_string(game->lastPoints)+" points",1248,830,14,green,true);
            const bool last=game->round==18&&game->activeIndex+1==game->players.size();
            const string next=game->players[(game->activeIndex+1)%game->players.size()].name;
            button({892,857,488,42},last ? "See final results" : "Continue to " + next,[this]{nextTurn();},Style::Primary);
        } else {
            const auto points=selected>=0 ? previewPoints(selected) : nullopt;
            text(selected<0 ? "Pick an open category to finish your turn." : string(categories[selected].name),892,830,13,selected<0 ? muted : green,selected>=0);
            const string title=game->current().computer ? "Computer is playing..." : selected<0 ? "Choose a category above"
                : points ? (*points==0 ? "Scratch category (0 points)" : "Record " + to_string(*points) + " points") : "Enter your dice or score";
            button({892,857,488,42},title,[this]{record();},points&&*points==0 ? Style::Red : Style::Primary,humanCanChoose()&&points.has_value());
        }
        if (!feedback.empty()) text(fit(feedback,488,11),892,903,11,error ? red : green);
    }

    void backdrop() {
        sf::RectangleShape shade({width,height}); shade.setFillColor({34,44,36,94}); window.draw(shade);
        buttons.clear(); fields.clear();
    }

    void drawRules() {
        backdrop(); panel({350,112,740,744});
        text("THE RULES",388,147,11,red,true);
        text("Six dice. Eighteen choices.",386,178,30,ink,true);
        float y=237;
        const auto section=[&](const string& heading,const string& description) {
            text(heading,390,y,15,ink,true); y+=25;
            y=wrapped(description,390,y,658,14,muted,21)+16;
        };
        section("A turn", "Roll up to three times. Keep any dice between rolls, then fill one unused category. You can stop early. Every category is used once; a zero scratches it.");
        section("Upper section", "Add the dice showing the category's face. An upper sum of 84 or more earns a 50-point bonus.");
        section("Pairs, triples and full house", "Different groups need different faces. Larger groups can supply smaller groups. Score only the required dice. A full house is three of one face plus two of another; one die is spare.");
        section("Straights and Chance", "Low straight 1-5 scores 15; high straight 2-6 scores 20. Full straight 1-6 (Cameron) scores 30. Chance is the sum of all six dice.");
        section("Super-Yatzy", "Six equal dice score 100 plus their sum: 106 to 136 points. There are no extra Yatzy bonuses or carried-over rolls.");
        section("Your own dice", "Enter all six final dice and let the game score them, or choose Enter score to record the category's points yourself. Equal final totals share the win.");
        button({390,793,660,42},"Got it",[this]{rules=false;},Style::Primary);
    }

    void drawConfirmation() {
        backdrop(); panel({450,320,540,300});
        text("A FRESH START",486,356,11,red,true);
        text("Start a new scorecard?",484,389,27,ink,true);
        wrapped("This will replace the game currently at the table.",486,440,460,16,muted,25);
        button({486,540,218,44},"Keep current game",[this]{confirmNew=false;setup=false;feedback.clear();},Style::Secondary);
        button({718,540,236,44},"Start new game",[this]{startGame();},Style::Primary);
    }

    void drawResult() {
        backdrop(); panel({410,150,620,680});
        const auto winners=game->winners();
        text("WELL PLAYED",452,188,12,red,true);
        const string title=winners.size()==1 ? game->players[winners[0]].name+" wins!" : "A shared victory!";
        text(fit(title,535,35,true),450,227,35,ink,true);
        text(to_string(total(game->players[winners[0]].card)),448,283,65,green,true);
        text("POINTS",589,327,12,muted,true);
        ruleLine(452,384,536);
        vector<size_t> order(game->players.size()); iota(order.begin(),order.end(),0);
        stable_sort(order.begin(),order.end(),[this](size_t a,size_t b){return total(game->players[a].card)>total(game->players[b].card);});
        float y=411;
        for (size_t p:order) {
            const bool win=ranges::find(winners,p)!=winners.end();
            text(fit(game->players[p].name,422,17),456,y,17,win ? green : muted,win);
            text(to_string(total(game->players[p].card)),929,y,17,ink,true); y+=31;
        }
        button({452,748,250,44},"View scorecard",[this]{result=false;},Style::Secondary);
        button({718,748,270,44},"Another game",[this]{result=false;setup=true;feedback.clear();},Style::Primary);
    }

    void draw() {
        window.clear(background);
        buttons.clear(); fields.clear();
        drawTop();
        if (setup) drawSetup();
        else if (game) { drawScorecard(); drawTray(); drawOptions(); }
        if (rules) drawRules();
        if (confirmNew) drawConfirmation();
        if (result) drawResult();
    }

    void makePreview() {
        vector<Player> players{{"Player 1",false,false},{"Computer",true,false}};
        game=make_unique<Game>(model,std::move(players));
        game->players[0].card[0]=4; game->players[0].card[1]=6;
        game->players[0].card[3]=12; game->players[0].card[4]=20;
        game->players[0].card[6]=12; game->players[0].card[12]=15;
        game->players[1].card[0]=2; game->players[1].card[1]=6;
        game->players[1].card[3]=16; game->players[1].card[4]=10;
        game->players[1].card[6]=12; game->players[1].card[12]=15;
        game->round=7; game->dice={2,2,4,6,6,6}; game->rolls=2;
        game->held={false,false,false,true,true,true};
        selected=5; setup=false;
    }
};

} // namespace desktop

int main(int argc, char* argv[]) {
    try {
        bool preview=false; string capture;
        for (int i=1;i<argc;++i) {
            const string arg=argv[i];
            if (arg=="--preview") preview=true;
            else if (arg=="--capture" && i+1<argc) capture=argv[++i];
            else if (arg.rfind("-psn_",0)!=0) throw invalid_argument("Unknown option: "+arg);
        }
        return desktop::App(preview,capture).run();
    } catch (const exception& error) {
        cerr << "Super Yatzy: " << error.what() << '\n';
        return 1;
    }
}
