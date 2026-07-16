const http = require("http");
const {WebSocketServer} = require("ws");
const crypto = require("crypto");

const PORT = Number(process.env.MOVIE_MATCH_PORT || 3002);
const SESSION_CODE_LENGTH = 6;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SOURCE_MOVIES = 500;
const SOURCE_MODES = new Set(["suggestions", "lists"]);

const server = http.createServer((req, res) => {
    const host = req.headers.host || `localhost:${PORT}`;
    const body = JSON.stringify({
        ok: true,
        service: "movie-match",
        websocketUrl: `ws://${host}`,
    }, null, 2);

    res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    });
    res.end(`${body}\n`);
});

const wss = new WebSocketServer({server});
const sessions = new Map();

const toId = () => String(crypto.randomInt(0, 10 ** SESSION_CODE_LENGTH)).padStart(SESSION_CODE_LENGTH, "0");
const toMessageId = () => crypto.randomBytes(8).toString("hex");

const now = () => Date.now();

const sendRaw = (socket, message) => {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(message);
};

const send = (socket, type, payload = {}) => {
    sendRaw(socket, JSON.stringify({type, payload}));
};

const createRoleId = (session) => {
    session.nextRoleNumber += 1;
    return `u${session.nextRoleNumber}`;
};

const getSourceMode = (value) => SOURCE_MODES.has(value) ? value : "suggestions";

const sanitizeProviderIds = (value) => Array.isArray(value)
    ? value.map((id) => String(id).replace(/[^\d]/g, "").trim()).filter(Boolean)
    : [];

const sanitizeMovies = (movies) => {
    const uniqueMovies = new Map();

    (Array.isArray(movies) ? movies : []).forEach((movie) => {
        const id = Number(movie?.ID);
        if (!Number.isFinite(id)) return;
        if (String(movie?.Type || "Movie") !== "Movie") return;
        if (uniqueMovies.has(id)) return;

        uniqueMovies.set(id, {
            ID: id,
            Title: String(movie?.Title || "Unknown"),
            PosterUrl: movie?.PosterUrl || undefined,
            BackgroundImageUrl: movie?.BackgroundImageUrl || movie?.BackdropUrl || movie?.Backdrop || undefined,
            Character: movie?.Character || undefined,
            Year: movie?.Year || undefined,
            Type: movie?.Type || undefined,
            AvailabilityStatus: movie?.AvailabilityStatus || undefined,
        });
    });

    return Array.from(uniqueMovies.values()).slice(0, MAX_SOURCE_MOVIES);
};

const getConnectedRoles = (session) => session.roles.filter((role) => Boolean(session.players[role]));
const getConnectedSockets = (session) => getConnectedRoles(session)
    .map((role) => session.players[role])
    .filter(Boolean);

const createRoleMap = (session, getValue) => Object.fromEntries(
    session.roles.map((role) => [role, getValue(role)])
);

const getRoleProgress = (session, role) => {
    const progress = Number(session.progressByRole?.[role]);
    return Number.isInteger(progress) && progress >= 0 ? progress : 0;
};

const getRoleCurrentMovie = (session, role) => session.moviePool[getRoleProgress(session, role)] ?? null;
const getRoleUpcomingMovie = (session, role) => session.moviePool[getRoleProgress(session, role) + 1] ?? null;
const hasRemainingMoviesForRole = (session, role) => Boolean(getRoleCurrentMovie(session, role));
const hasRemainingMoviesForAnyConnectedRole = (session) => getConnectedRoles(session)
    .some((role) => hasRemainingMoviesForRole(session, role));

const getMovieVotes = (session, movieId) => {
    const key = String(movieId);
    if (!session.movieVotes[key]) {
        session.movieVotes[key] = {};
    }

    return session.movieVotes[key];
};

const peekMovieVotes = (session, movieId) => session.movieVotes[String(movieId)] ?? {};

const getUnlockedMatchedMovieIdsForRole = (session, role) => Array.isArray(session.unlockedMatchedMovieIdsByRole?.[role])
    ? session.unlockedMatchedMovieIdsByRole[role]
    : [];

const getHiddenMatchedMovieIdsForRole = (session, role) => Array.isArray(session.hiddenMatchedMovieIdsByRole?.[role])
    ? session.hiddenMatchedMovieIdsByRole[role]
    : [];

const unlockMatchedMovieForRole = (session, role, movieId) => {
    if (!role || !movieId) return;

    if (!Array.isArray(session.unlockedMatchedMovieIdsByRole?.[role])) {
        session.unlockedMatchedMovieIdsByRole[role] = [];
    }

    if (session.unlockedMatchedMovieIdsByRole[role].includes(movieId)) return;
    session.unlockedMatchedMovieIdsByRole[role].push(movieId);
};

const hideMatchedMovieForRole = (session, role, movieId) => {
    if (!role || !movieId) return;

    if (!Array.isArray(session.hiddenMatchedMovieIdsByRole?.[role])) {
        session.hiddenMatchedMovieIdsByRole[role] = [];
    }

    if (session.hiddenMatchedMovieIdsByRole[role].includes(movieId)) return;
    session.hiddenMatchedMovieIdsByRole[role].push(movieId);
};

const persistMatchedMovieUnlocks = (session, movie) => {
    if (!movie?.ID) return;

    const connectedRoles = getConnectedRoles(session);
    connectedRoles.forEach((role) => {
        if (peekMovieVotes(session, movie.ID)[role] === "yes") {
            unlockMatchedMovieForRole(session, role, movie.ID);
        }
    });
};

const pushHostSoloMatchedMovie = (session, movie) => {
    if (!movie?.ID) return;

    const connectedRoles = getConnectedRoles(session);
    if (connectedRoles.length !== 1) return;
    if (connectedRoles[0] !== session.hostRole) return;
    if (session.hostSoloMatchedMovieIds.includes(movie.ID)) return;

    session.hostSoloMatchedMovieIds.push(movie.ID);
};

const pushMatchedMovie = (session, movie) => {
    if (!movie) return;
    if (session.matchedMovies.some((entry) => entry.ID === movie.ID)) return;
    session.matchedMovies.push(movie);
    pushHostSoloMatchedMovie(session, movie);
};

const hasMatchedMovie = (session, movieId) => session.matchedMovies
    .some((entry) => Number(entry?.ID) === Number(movieId));

const findPendingMatchedMovie = (session) => {
    const connectedRoles = getConnectedRoles(session);
    if (!connectedRoles.length) return null;

    return session.moviePool.find((movie) => {
        if (!movie?.ID) return false;
        if (session.dismissedMatchMovieIds.has(movie.ID)) return false;

        const votes = peekMovieVotes(session, movie.ID);
        return connectedRoles.length > 0 && connectedRoles.every((role) => votes[role] === "yes");
    }) ?? null;
};

const syncSessionPhase = (session, options = {}) => {
    const allowPendingMatch = options.allowPendingMatch !== false;
    const activeMatchedMovie = session.matchedMovie && !session.dismissedMatchMovieIds.has(session.matchedMovie.ID)
        ? session.matchedMovie
        : null;
    const pendingMatchedMovie = activeMatchedMovie ?? (allowPendingMatch ? findPendingMatchedMovie(session) : null);

    session.matchedMovie = pendingMatchedMovie;
    if (pendingMatchedMovie) {
        pushMatchedMovie(session, pendingMatchedMovie);
        persistMatchedMovieUnlocks(session, pendingMatchedMovie);
        session.phase = "match_prompt";
        return;
    }

    session.phase = hasRemainingMoviesForAnyConnectedRole(session)
        ? "voting"
        : "finished_no_match";
};

const createVoteStatsByRole = (session) => createRoleMap(session, (role) => {
    let yes = 0;
    let no = 0;

    Object.values(session.movieVotes).forEach((votes) => {
        if (votes?.[role] === "yes") yes += 1;
        if (votes?.[role] === "no") no += 1;
    });

    const total = yes + no;

    return {
        yes,
        no,
        total,
        yesRatio: total > 0 ? yes / total : 0,
        noRatio: total > 0 ? no / total : 0,
    };
});

const broadcastToSession = (session, type, payload = {}, options = {}) => {
    const message = JSON.stringify({type, payload});
    const excludedRoles = new Set(Array.isArray(options.excludeRoles) ? options.excludeRoles : []);

    getConnectedRoles(session)
        .filter((role) => !excludedRoles.has(role))
        .map((role) => session.players[role])
        .filter(Boolean)
        .forEach((socket) => sendRaw(socket, message));
};

const markSessionTouched = (session) => {
    session.updatedAt = now();
};

const broadcastState = (session) => {
    markSessionTouched(session);
    broadcastToSession(session, "session_state", {
        code: session.code,
        hostRole: session.hostRole,
        sourceMode: session.sourceMode,
        phase: session.phase,
        sourceVersion: session.sourceVersion,
        filterUrl: session.filterUrl,
        selectedListId: session.selectedListId,
        selectedProviderIds: session.selectedProviderIds,
        currentMovie: getRoleCurrentMovie(session, session.hostRole),
        upcomingMovie: getRoleUpcomingMovie(session, session.hostRole),
        currentMovieByRole: createRoleMap(session, (role) => getRoleCurrentMovie(session, role)),
        upcomingMovieByRole: createRoleMap(session, (role) => getRoleUpcomingMovie(session, role)),
        matchedMovie: session.matchedMovie,
        matchedMovies: session.matchedMovies,
        unlockedMatchedMovieIdsByRole: createRoleMap(session, (role) => getUnlockedMatchedMovieIdsForRole(session, role)),
        hiddenMatchedMovieIdsByRole: createRoleMap(session, (role) => getHiddenMatchedMovieIdsForRole(session, role)),
        hostSoloMatchedMovieIds: session.hostSoloMatchedMovieIds,
        voteStatsByRole: createVoteStatsByRole(session),
        moviePool: session.moviePool,
        votesDone: createRoleMap(session, () => false),
        usersReady: createRoleMap(session, (role) => Boolean(session.players[role])),
    });
};

const createChatMessage = (role, text) => ({
    id: toMessageId(),
    role,
    text: text.slice(0, 1000),
    createdAt: new Date().toISOString(),
});

const pushChatMessage = (session, message, options = {}) => {
    session.chatMessages.push(message);
    if (session.chatMessages.length > 100) {
        session.chatMessages.shift();
    }

    broadcastToSession(session, "chat_message", message, options);
};

const createSession = (socket, options = {}) => {
    const sourceMode = getSourceMode(options.sourceMode);
    const initialMovies = sanitizeMovies(options.movies);
    const initialFilterUrl = typeof options.filterUrl === "string" && options.filterUrl.trim()
        ? options.filterUrl.trim()
        : null;
    const initialSelectedListId = options.selectedListId ? String(options.selectedListId) : null;
    const initialSelectedProviderIds = sanitizeProviderIds(options.selectedProviderIds);
    let code = toId();
    while (sessions.has(code)) {
        code = toId();
    }

    const hostRole = "u1";
    const session = {
        code,
        hostRole,
        sourceMode,
        sourceVersion: initialMovies.length > 0 ? 1 : 0,
        phase: initialMovies.length > 0 ? "voting" : "loading_source",
        filterUrl: initialFilterUrl,
        selectedListId: initialSelectedListId,
        selectedProviderIds: initialSelectedProviderIds,
        currentMovie: null,
        upcomingMovie: null,
        matchedMovie: null,
        matchedMovies: [],
        unlockedMatchedMovieIdsByRole: {[hostRole]: []},
        hiddenMatchedMovieIdsByRole: {[hostRole]: []},
        hostSoloMatchedMovieIds: [],
        moviePool: initialMovies,
        roles: [hostRole],
        nextRoleNumber: 1,
        players: {[hostRole]: socket},
        progressByRole: {[hostRole]: 0},
        movieVotes: {},
        dismissedMatchMovieIds: new Set(),
        chatMessages: [],
        updatedAt: now(),
    };

    sessions.set(code, session);
    socket.meta = {code, role: hostRole};

    syncSessionPhase(session);

    send(socket, "session_created", {code, role: hostRole, sourceMode});
    send(socket, "chat_history", session.chatMessages);
    broadcastState(session);
};

const cleanupExpiredSessions = () => {
    const expiryThreshold = now() - SESSION_TTL_MS;

    sessions.forEach((session, code) => {
        const hasConnectedPlayers = getConnectedRoles(session).length > 0;
        if (hasConnectedPlayers) return;
        if (session.updatedAt >= expiryThreshold) return;
        sessions.delete(code);
    });
};

setInterval(cleanupExpiredSessions, 10 * 60 * 1000).unref();

const detachSocketFromCurrentSession = (socket) => {
    const {code, role} = socket.meta || {};
    if (!code || !role) return;

    const session = sessions.get(code);
    if (!session) return;

    if (session.players[role] === socket) {
        session.players[role] = null;
    }

    syncSessionPhase(session, {allowPendingMatch: false});
    broadcastState(session);
};

wss.on("connection", (socket) => {
    socket.meta = {code: null, role: null};

    socket.on("message", (raw) => {
        let message;
        try {
            message = JSON.parse(String(raw));
        } catch {
            send(socket, "session_error", {message: "Invalid payload"});
            return;
        }

        const {type, payload = {}} = message;

        if (type === "ping") {
            send(socket, "pong", {ts: Date.now()});
            return;
        }

        if (type === "create_session") {
            detachSocketFromCurrentSession(socket);
            createSession(socket, payload);
            return;
        }

        if (type === "join_session") {
            detachSocketFromCurrentSession(socket);
            const code = String(payload.code || "").replace(/\D/g, "").trim();
            const session = sessions.get(code);

            if (!session) {
                send(socket, "session_error", {message: "Session not found"});
                return;
            }

            const role = createRoleId(session);
            session.roles.push(role);
            session.players[role] = socket;
            session.progressByRole[role] = 0;
            session.unlockedMatchedMovieIdsByRole[role] = [];
            session.hiddenMatchedMovieIdsByRole[role] = [];
            socket.meta = {code, role};
            markSessionTouched(session);

            send(socket, "session_joined", {
                code,
                role,
                sourceMode: session.sourceMode,
            });
            send(socket, "chat_history", session.chatMessages);
            syncSessionPhase(session);
            broadcastState(session);
            return;
        }

        if (type === "rejoin_session") {
            detachSocketFromCurrentSession(socket);

            const code = String(payload.code || "").replace(/\D/g, "").trim();
            const role = String(payload.role || "").trim();
            const session = sessions.get(code);

            if (!session) {
                send(socket, "session_error", {message: "Session not found"});
                return;
            }

            if (!session.roles.includes(role)) {
                send(socket, "session_error", {message: "Invalid role for session"});
                return;
            }

            const currentSocketForRole = session.players[role];
            if (currentSocketForRole && currentSocketForRole !== socket) {
                send(socket, "session_error", {message: "Role is already connected"});
                return;
            }

            session.players[role] = socket;
            socket.meta = {code, role};
            markSessionTouched(session);

            send(socket, "session_rejoined", {
                code,
                role,
                sourceMode: session.sourceMode,
            });
            send(socket, "chat_history", session.chatMessages);
            syncSessionPhase(session);
            broadcastState(session);
            return;
        }

        if (type === "update_session_source") {
            const code = String(payload.code || "").replace(/\D/g, "").trim();
            const role = String(payload.role || "").trim();
            const session = sessions.get(code);

            if (!session || session.hostRole !== role) return;
            if (session.players[role] !== socket) return;

            const nextMovies = sanitizeMovies(payload.movies);
            const nextSourceMode = getSourceMode(payload.sourceMode);

            session.sourceMode = nextSourceMode;
            session.filterUrl = typeof payload.filterUrl === "string" && payload.filterUrl.trim()
                ? payload.filterUrl.trim()
                : null;
            session.selectedListId = payload.selectedListId ? String(payload.selectedListId) : null;
            session.selectedProviderIds = sanitizeProviderIds(payload.selectedProviderIds);
            session.moviePool = nextMovies;
            session.matchedMovie = null;
            session.currentMovie = null;
            session.upcomingMovie = null;
            session.progressByRole = createRoleMap(session, () => 0);
            session.movieVotes = {};
            session.dismissedMatchMovieIds = new Set();
            session.hiddenMatchedMovieIdsByRole = createRoleMap(session, () => []);
            session.sourceVersion += 1;
            syncSessionPhase(session);
            broadcastState(session);
            return;
        }

        if (type === "vote_movie") {
            const code = String(payload.code || "").replace(/\D/g, "").trim();
            const role = String(payload.role || "").trim();
            const vote = payload.vote;
            const movieId = Number(payload.movieId);
            const session = sessions.get(code);

            if (!session || session.phase !== "voting") return;
            if (!session.roles.includes(role)) return;
            if (session.players[role] !== socket) return;
            if (vote !== "yes" && vote !== "no") return;
            if (!Number.isFinite(movieId)) return;

            const currentMovie = getRoleCurrentMovie(session, role);
            if (!currentMovie || currentMovie.ID !== movieId) return;

            getMovieVotes(session, currentMovie.ID)[role] = vote;
            if (vote === "yes" && hasMatchedMovie(session, currentMovie.ID)) {
                unlockMatchedMovieForRole(session, role, currentMovie.ID);
            }
            session.progressByRole[role] = getRoleProgress(session, role) + 1;
            syncSessionPhase(session);
            broadcastState(session);
            return;
        }

        if (type === "continue_after_match") {
            const code = String(payload.code || "").replace(/\D/g, "").trim();
            const role = String(payload.role || "").trim();
            const session = sessions.get(code);

            if (!session || session.phase !== "match_prompt") return;
            if (!session.roles.includes(role)) return;
            if (session.players[role] !== socket) return;

            if (session.matchedMovie?.ID) {
                session.dismissedMatchMovieIds.add(session.matchedMovie.ID);
            }
            session.matchedMovie = null;
            syncSessionPhase(session);
            broadcastState(session);
            return;
        }

        if (type === "dismiss_match_for_role") {
            const code = String(payload.code || "").replace(/\D/g, "").trim();
            const role = String(payload.role || "").trim();
            const movieId = Number(payload.movieId);
            const session = sessions.get(code);

            if (!session || !session.roles.includes(role)) return;
            if (session.players[role] !== socket) return;
            if (!Number.isFinite(movieId)) return;

            hideMatchedMovieForRole(session, role, movieId);
            markSessionTouched(session);
            broadcastState(session);
            return;
        }

        if (type === "send_chat_message") {
            const code = String(payload.code || "").replace(/\D/g, "").trim();
            const role = String(payload.role || "").trim();
            const text = String(payload.text || "").trim();
            const session = sessions.get(code);

            if (!session || !session.roles.includes(role)) return;
            if (session.players[role] !== socket) return;
            if (!text) return;

            pushChatMessage(session, createChatMessage(role, text));
            markSessionTouched(session);
            return;
        }

        if (type === "send_system_chat_message") {
            const code = String(payload.code || "").replace(/\D/g, "").trim();
            const role = String(payload.role || "").trim();
            const text = String(payload.text || "").trim();
            const excludeRole = typeof payload.excludeRole === "string" ? String(payload.excludeRole).trim() : "";
            const session = sessions.get(code);

            if (!session || session.hostRole !== role) return;
            if (session.players[role] !== socket) return;
            if (!text) return;

            pushChatMessage(session, createChatMessage("system", text), {
                excludeRoles: excludeRole ? [excludeRole] : [],
            });
            markSessionTouched(session);
            return;
        }

        if (type === "leave_session") {
            detachSocketFromCurrentSession(socket);
            socket.meta = {code: null, role: null};
            send(socket, "session_left", {ok: true});
        }
    });

    socket.on("close", () => {
        detachSocketFromCurrentSession(socket);
    });

    socket.on("error", () => {
        detachSocketFromCurrentSession(socket);
    });
});

server.listen(PORT, () => {
    console.log(`[movie-match] server listening on http://localhost:${PORT}`);
});
