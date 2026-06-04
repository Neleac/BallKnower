(function() {
  "use strict";

  var CONFIG = {
    endpoint: "/api/scoreboard",
    playByPlayEndpoint: "/api/playbyplay",
    refreshMs: 10000,
    playByPlayRefreshMs: 15000,
    cacheKey: "ballknower:lastScoreboard",
    appName: "BallKnower",
  };

  var OPENING_CLOCK_TEXT = "Q1 12:00";

  var state = {
    games: [],
    selectedIndex: 0,
    scorePosition: "center",
    playByPlayText: "",
    playByPlayGameId: "",
    playByPlayLoading: false,
    playByPlayTimer: null,
    lastSpokenPlayByPlayText: "",
    pendingPlayByPlaySpeech: "",
    speechUnlocked: false,
    speechUnlocking: false,
    loading: false,
    timer: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function setupEvents() {
    document.addEventListener("keydown", function(event) {
      switch (event.key) {
        case "ArrowLeft":
          selectGame(state.selectedIndex - 1);
          event.preventDefault();
          break;
        case "ArrowRight":
          selectGame(state.selectedIndex + 1);
          event.preventDefault();
          break;
        case "ArrowUp":
          unlockPlayByPlaySpeech();
          setScorePosition("up");
          event.preventDefault();
          break;
        case "ArrowDown":
          setScorePosition("center");
          event.preventDefault();
          break;
        case "Enter":
          unlockPlayByPlaySpeech();
          loadScoreboard({ force: true });
          loadPlayByPlay({ force: true });
          event.preventDefault();
          break;
      }
    });

    document.addEventListener("visibilitychange", function() {
      if (document.hidden) {
        stopAutoRefresh();
        stopPlayByPlayRefresh();
        stopPlayByPlaySpeech();
      } else {
        loadScoreboard({ silent: true });
        startAutoRefresh();
        startPlayByPlayRefresh();
      }
    });
  }

  function installAppUrl() {
    return window.location.origin + "/?display=1";
  }

  function installDeepLink() {
    return "fb-viewapp://web_app_deep_link?appName=" + encodeURIComponent(CONFIG.appName) +
      "&appUrl=" + encodeURIComponent(installAppUrl());
  }

  function isMobileBrowser() {
    var userAgent = navigator.userAgent || "";
    return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) ||
      (navigator.maxTouchPoints > 0 && Math.min(window.screen.width, window.screen.height) < 760);
  }

  function isLocalHost() {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  }

  function shouldShowInstallPage() {
    var params = new URLSearchParams(window.location.search);
    if (params.get("display") === "1") return false;
    if (params.get("install") === "1") return true;
    return !isLocalHost();
  }

  function showInstallPage() {
    var mobile = isMobileBrowser();
    var viewport = document.querySelector("meta[name='viewport']");
    if (viewport) viewport.setAttribute("content", "width=device-width, initial-scale=1.0");

    document.documentElement.classList.add("install-mode");
    document.body.classList.add("install-mode");
    setHidden("install-page", false);
    setHidden("app", true);
    setHidden("install-desktop", mobile);
    setHidden("install-mobile", !mobile);
    $("install-action").setAttribute("href", installDeepLink());
    $("install-url").textContent = installAppUrl();
  }

  function loadCachedScoreboard() {
    try {
      var cached = JSON.parse(localStorage.getItem(CONFIG.cacheKey) || "null");
      if (cached && Array.isArray(cached.games)) {
        applyScoreboard(cached, { cached: true });
      }
    } catch (error) {
      localStorage.removeItem(CONFIG.cacheKey);
    }
  }

  function saveCachedScoreboard(data) {
    try {
      localStorage.setItem(CONFIG.cacheKey, JSON.stringify(data));
    } catch (error) {
      // The app can still run without local storage.
    }
  }

  function loadScoreboard(options) {
    options = options || {};
    if (state.loading) return;

    state.loading = true;
    setLoading(!options.silent && state.games.length === 0);
    clearError();
    setPill("Loading", "");

    fetch(CONFIG.endpoint + (options.force ? "?t=" + Date.now() : ""), {
      cache: options.force ? "no-store" : "default",
    })
      .then(function(response) {
        return response.json().catch(function() {
          return {};
        }).then(function(data) {
          if (!response.ok) {
            throw new Error(data.error || ("Score service " + response.status));
          }
          return data;
        });
      })
      .then(function(data) {
        saveCachedScoreboard(data);
        applyScoreboard(data);
      })
      .catch(function(error) {
        setPill("Offline", "error");
        if (state.games.length === 0) {
          setError(error.message || "Unable to load scores");
        }
      })
      .finally(function() {
        state.loading = false;
        setLoading(false);
      });
  }

  function applyScoreboard(data, options) {
    options = options || {};
    state.games = Array.isArray(data.games) ? data.games : [];
    if (state.selectedIndex >= state.games.length) state.selectedIndex = 0;
    renderCurrentGame(data, options);
    loadPlayByPlay({ silent: true });
  }

  function selectGame(index) {
    if (state.games.length === 0) return;
    state.selectedIndex = (index + state.games.length) % state.games.length;
    renderCurrentGame();
    loadPlayByPlay({ force: true });
  }

  function getCurrentGame() {
    return state.games.length > 0 ? state.games[state.selectedIndex] : null;
  }

  function renderCurrentGame(data, options) {
    var game = getCurrentGame();

    if (!game) {
      setHidden("game-card", true);
      setHidden("empty-state", false);
      state.playByPlayText = "";
      state.playByPlayGameId = "";
      $("series-record").textContent = "";
      $("matchup-row").classList.remove("has-series");
      setHidden("series-record", true);
      stopPlayByPlaySpeech();
      return;
    }

    setHidden("game-card", false);
    setHidden("empty-state", true);

    var status = statusLabel(game);
    applyScorePosition();
    setPill(status.compact, status.isLive ? "live" : "");
    $("game-status").textContent = gameTopLeftText(game);
    $("game-status").classList.toggle("live", hasGameStarted(game));
    $("game-count").textContent = seriesGameText(game);
    renderSeriesRecord(game);

    $("away-code").textContent = game.away.code;
    $("away-name").textContent = game.away.name;
    $("away-score").textContent = scoreText(game.away.score);
    $("home-code").textContent = game.home.code;
    $("home-name").textContent = game.home.name;
    $("home-score").textContent = scoreText(game.home.score);
    renderPlayByPlay(game);

    $("away-row").classList.toggle("leading", Number(game.away.score) > Number(game.home.score));
    $("home-row").classList.toggle("leading", Number(game.home.score) > Number(game.away.score));
  }

  function statusLabel(game) {
    var text = game.statusText || "";
    var phase = Number(game.status);
    var isLive = phase === 2 || /Q|Half|OT|LIVE/i.test(text);
    var isFinal = phase === 3 || /final/i.test(text);

    if (isLive) return { label: text || "Live", compact: "Live", isLive: true };
    if (isFinal) return { label: text || "Final", compact: "Final", isLive: false };
    return { label: text || "Pregame", compact: "Ready", isLive: false };
  }

  function gameStartTime(game) {
    var startTime = String(game.startTime || "").trim();
    if (!startTime || startTime === "TBD") return "TBD";
    return startTime.replace(/\s(?:PST|PDT)$/i, "") + " PST";
  }

  function gameTopLeftText(game) {
    return hasGameStarted(game) ? gameClock(game) : gameStartTime(game);
  }

  function seriesTextParts(game) {
    return [
      game.seriesGameNumber,
      game.seriesText,
      game.gameLabel,
      game.gameSubLabel,
      game.gameSubtype,
      game.ifNecessary,
    ].map(function(value) {
      return String(value || "").trim();
    }).filter(Boolean);
  }

  function isSeriesGame(game) {
    var text = seriesTextParts(game).join(" ");
    if (!text) return false;
    if (String(game.seriesText || "").trim()) return true;
    if (parsedSeriesGameNumber(game)) return true;
    return /\b(series|playoffs?|finals?|semifinals?|conference|first round|second round)\b/i.test(text);
  }

  function parsedSeriesGameNumber(game) {
    var raw = String(game.seriesGameNumber || "").trim();
    var match = raw.match(/\d+/);
    if (match && Number(match[0]) > 0) return Number(match[0]);

    var parts = seriesTextParts(game);
    for (var index = 0; index < parts.length; index += 1) {
      match = parts[index].match(/\b(?:game|gm)\.?\s*(\d+)\b/i);
      if (match) return Number(match[1]);
    }
    return 0;
  }

  function seriesGameText(game) {
    if (!isSeriesGame(game)) return "";

    var raw = String(game.seriesGameNumber || "").trim();
    if (!raw || raw === "0") raw = seriesTextParts(game).join(" ");
    var explicit = raw.match(/^game\s+(\d+)/i);
    if (explicit) return "Game " + explicit[1];

    var gameNumber = parsedSeriesGameNumber(game);
    return gameNumber ? "Game " + gameNumber : "";
  }

  function seriesRecordText(game) {
    if (!isSeriesGame(game)) return "";

    var gameNumber = parsedSeriesGameNumber(game);
    if (gameNumber === 1) return "0-0";

    var parts = seriesTextParts(game);
    for (var index = 0; index < parts.length; index += 1) {
      var records = parts[index].match(/\b\d+\s*-\s*\d+\b/g);
      if (records && records.length) return records[records.length - 1].replace(/\s+/g, "");
    }
    return "";
  }

  function renderSeriesRecord(game) {
    var record = seriesRecordText(game);
    $("series-record").textContent = record;
    $("matchup-row").classList.toggle("has-series", Boolean(record));
    setHidden("series-record", !record);
  }

  function gameClock(game) {
    var status = statusLabel(game);
    if (status.isFinal) return status.label || "Final";

    var period = Number(game.period);
    if (period && game.clock) return "Q" + period + " " + game.clock;
    if (period) return "Q" + period;
    if (!hasGameStarted(game)) return OPENING_CLOCK_TEXT;
    return game.startTime || "TBD";
  }

  function hasGameStarted(game) {
    var phase = Number(game.status);
    var text = game.statusText || "";
    return phase === 2 || phase === 3 || /Q|Half|OT|Final|LIVE/i.test(text) || Number(game.period) > 0;
  }

  function scoreText(value) {
    var score = Number(value);
    return Number.isFinite(score) ? String(score) : "0";
  }

  function loadPlayByPlay(options) {
    options = options || {};
    if (state.scorePosition !== "up") return;

    var game = getCurrentGame();
    var gameId = game && game.gameId;
    if (!gameId) {
      setPlayByPlay("", "");
      return;
    }
    if (state.playByPlayLoading) return;

    state.playByPlayLoading = true;
    fetch(CONFIG.playByPlayEndpoint + "?gameId=" + encodeURIComponent(gameId) + "&t=" + Date.now(), {
      cache: "no-store",
    })
      .then(function(response) {
        return response.json().catch(function() {
          return {};
        }).then(function(data) {
          if (!response.ok) {
            throw new Error(data.error || ("Play-by-play service " + response.status));
          }
          return data;
        });
      })
      .then(function(data) {
        var current = getCurrentGame();
        if (state.scorePosition !== "up" || !current || current.gameId !== gameId) return;
        setPlayByPlay(data.playByPlayText || "", gameId);
      })
      .catch(function() {
        var current = getCurrentGame();
        if (state.scorePosition === "up" && current && current.gameId === gameId && state.playByPlayGameId !== gameId) {
          setPlayByPlay("", gameId);
        }
      })
      .finally(function() {
        state.playByPlayLoading = false;
      });
  }

  function setScorePosition(position) {
    var nextPosition = position === "up" ? "up" : "center";
    if (state.scorePosition === nextPosition) return;

    state.scorePosition = nextPosition;
    applyScorePosition();
    renderPlayByPlay();
    if (state.scorePosition === "up") {
      startPlayByPlayRefresh();
    } else {
      stopPlayByPlaySpeech();
      stopPlayByPlayRefresh();
    }
  }

  function applyScorePosition() {
    var card = $("game-card");
    if (!card) return;
    card.classList.toggle("score-position-up", state.scorePosition === "up");
  }

  function setPlayByPlay(text, gameId) {
    state.playByPlayGameId = gameId || "";
    state.playByPlayText = text || "";
    renderPlayByPlay(getCurrentGame());
  }

  function renderPlayByPlay(game) {
    var play = $("play-by-play");
    if (!play) return;

    var shouldShow = state.scorePosition === "up";
    play.classList.toggle("hidden", !shouldShow);
    play.setAttribute("aria-hidden", shouldShow ? "false" : "true");
    if (!shouldShow) return;

    if (game && game.gameId && state.playByPlayGameId === game.gameId) {
      renderPlayByPlayText(play, state.playByPlayText || "");
    } else {
      renderPlayByPlayText(play, (game && game.playByPlayText) || "");
    }
  }

  function renderPlayByPlayText(play, text) {
    fitPlayByPlayText(play, text);
    speakPlayByPlay(text);
  }

  function playTextSize(text) {
    var length = String(text || "").replace(/\s+/g, " ").trim().length;
    if (length <= 42) return 46;
    if (length <= 70) return 40;
    if (length <= 105) return 34;
    if (length <= 145) return 28;
    if (length <= 200) return 22;
    return 18;
  }

  function fitPlayByPlayText(play, text) {
    var size = playTextSize(text);
    play.textContent = text;
    play.style.setProperty("--play-font-size", size + "px");

    while (size > 14 && (play.scrollHeight > play.clientHeight || play.scrollWidth > play.clientWidth)) {
      size -= 1;
      play.style.setProperty("--play-font-size", size + "px");
    }
  }

  function speakPlayByPlay(text) {
    var spokenText = String(text || "").replace(/\s+/g, " ").trim();
    if (!spokenText || state.scorePosition !== "up") return;
    if (document.hidden) return;
    if (spokenText === state.lastSpokenPlayByPlayText) return;
    if (!canUseSpeechSynthesis()) return;

    if (!state.speechUnlocked) {
      state.pendingPlayByPlaySpeech = spokenText;
      return;
    }

    try {
      state.pendingPlayByPlaySpeech = "";
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
      window.speechSynthesis.cancel();

      var utterance = new SpeechSynthesisUtterance(spokenText);
      utterance.lang = "en-US";
      utterance.rate = 1;
      utterance.pitch = 1;
      window.speechSynthesis.speak(utterance);
      state.lastSpokenPlayByPlayText = spokenText;
    } catch (error) {
      state.pendingPlayByPlaySpeech = spokenText;
    }
  }

  function canUseSpeechSynthesis() {
    return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  }

  function unlockPlayByPlaySpeech() {
    if (!canUseSpeechSynthesis()) return;
    if (state.speechUnlocked || state.speechUnlocking) return;

    state.speechUnlocking = true;
    try {
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();

      var unlockUtterance = new SpeechSynthesisUtterance(".");
      unlockUtterance.lang = "en-US";
      unlockUtterance.volume = 0.01;
      unlockUtterance.rate = 1;
      unlockUtterance.pitch = 1;
      unlockUtterance.onend = finishSpeechUnlock;
      unlockUtterance.onerror = finishSpeechUnlock;
      window.speechSynthesis.speak(unlockUtterance);

      window.setTimeout(function() {
        if (state.speechUnlocking) finishSpeechUnlock();
      }, 750);
    } catch (error) {
      state.speechUnlocking = false;
    }
  }

  function finishSpeechUnlock() {
    state.speechUnlocked = true;
    state.speechUnlocking = false;
    speakPendingPlayByPlay();
  }

  function speakPendingPlayByPlay() {
    if (!state.pendingPlayByPlaySpeech) return;
    var pendingText = state.pendingPlayByPlaySpeech;
    state.pendingPlayByPlaySpeech = "";
    speakPlayByPlay(pendingText);
  }

  function stopPlayByPlaySpeech() {
    state.pendingPlayByPlaySpeech = "";
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }

  function startPlayByPlayRefresh() {
    stopPlayByPlayRefresh();
    if (state.scorePosition !== "up") return;

    loadPlayByPlay({ force: true });
    state.playByPlayTimer = window.setInterval(function() {
      loadPlayByPlay({ silent: true });
    }, CONFIG.playByPlayRefreshMs);
  }

  function stopPlayByPlayRefresh() {
    if (state.playByPlayTimer) {
      window.clearInterval(state.playByPlayTimer);
      state.playByPlayTimer = null;
    }
  }

  function setLoading(isLoading) {
    setHidden("loading", !isLoading);
  }

  function setError(message) {
    $("error").classList.remove("hidden");
    $("game-card").classList.add("hidden");
    setHidden("empty-state", true);
    $("error").querySelector(".error-message").textContent = message;
  }

  function clearError() {
    setHidden("error", true);
  }

  function setHidden(id, hidden) {
    var element = $(id);
    if (element) element.classList.toggle("hidden", hidden);
  }

  function setPill(text, type) {
    // The app has no chrome; keep the score window as the only visible surface.
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    state.timer = window.setInterval(function() {
      loadScoreboard({ silent: true });
    }, CONFIG.refreshMs);
  }

  function stopAutoRefresh() {
    if (state.timer) {
      window.clearInterval(state.timer);
      state.timer = null;
    }
  }

  function init() {
    registerServiceWorker();

    if (shouldShowInstallPage()) {
      showInstallPage();
      return;
    }

    setupEvents();
    applyScorePosition();
    loadCachedScoreboard();
    loadScoreboard({ force: true });
    startAutoRefresh();
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(function() {
      // Static caching is optional; live scores still work without it.
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
