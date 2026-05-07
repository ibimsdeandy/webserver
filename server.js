const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
//const { createLogger } = require("./logger");

//const logger = createLogger("watchMatchServer");

const PORT = Number(process.env.WATCH_MATCH_PORT || 3001);
const server = http.createServer((req, res) => {
    const host = req.headers.host || `localhost:${PORT}`;
    const body = JSON.stringify({
        ok: true,
        service: "watch-match",
        websocketUrl: `ws://${host}`,
    }, null, 2);

    res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    });
    res.end(`${body}\n`);
});
const wss = new WebSocketServer({ server });

const sessions = new Map();

const SESSION_CODE_LENGTH = 6;
const MIN_PARTICIPANTS = 1;
const MAX_PARTICIPANTS = 10;
const DEFAULT_PARTICIPANTS = 2;
const MIN_PICK_COUNT = 1;
const MAX_PICK_COUNT = 150;
const DEFAULT_PICK_COUNT = 5;
const DEFAULT_MODE = "watch_now";
const SESSION_MODES = new Set(["watch_now", "later"]);
const ROLE_NAMES = Array.from({ length: MAX_PARTICIPANTS }, (_, index) => String.fromCharCode(97 + index));

const toId = () => String(crypto.randomInt(0, 10 ** SESSION_CODE_LENGTH)).padStart(SESSION_CODE_LENGTH, "0");
const toMessageId = () => crypto.randomBytes(8).toString("hex");
const clampInteger = (value, min, max, fallback) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(min, Math.min(max, Math.round(numeric)));
};

const send = (socket, type, payload = {}) => {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify({ type, payload }));
};

const getSessionSockets = (session) => session.roles
    .map((role) => session.players[role])
    .filter(Boolean);

const createRoleMap = (session, getValue) => Object.fromEntries(
    session.roles.map((role) => [role, getValue(role)])
);

const allPlayersConnected = (session) => session.roles.every((role) => Boolean(session.players[role]));
const allPicksDone = (session) => session.roles.every((role) => session.picks[role].length === session.pickCount);
const allVotesDone = (session) => session.roles.every((role) => Boolean(session.votes[role]));
const resetVotes = (session) => {
    session.votes = createRoleMap(session, () => null);
};
const isHost = (session, role) => role === session.roles[0];
const getMode = (value) => SESSION_MODES.has(value) ? value : DEFAULT_MODE;
const sanitizeProviderIds = (value) => Array.isArray(value)
    ? value.map((id) => String(id).replace(/[^\d]/g, "").trim()).filter(Boolean)
    : [];
const finishVoting = (session) => {
    session.phase = session.mode === "later" && session.matchedMovies.length > 0
        ? "finished_with_matches"
        : "finished_no_match";
    session.currentMovie = null;
    session.upcomingMovie = null;
};

const broadcastState = (session) => {
    const payload = {
        code: session.code,
        participantCount: session.participantCount,
        pickCount: session.pickCount,
        mode: session.mode,
        hostRole: session.roles[0],
        selectedProviderIds: session.selectedProviderIds,
        phase: session.phase,
        currentMovie: session.currentMovie,
        upcomingMovie: session.upcomingMovie,
        matchedMovie: session.matchedMovie,
        matchedMovies: session.matchedMovies,
        moviePool: session.roles
            .flatMap((role) => session.picks[role])
            .reduce((acc, movie) => {
                if (!acc.some((item) => item.ID === movie.ID)) acc.push(movie);
                return acc;
            }, []),
        picksDone: createRoleMap(session, (role) => session.picks[role].length === session.pickCount),
        usersReady: createRoleMap(session, (role) => Boolean(session.players[role])),
        votesDone: createRoleMap(session, (role) => Boolean(session.votes[role])),
    };

    getSessionSockets(session).forEach((ws) => send(ws, "session_state", payload));
};

const createChatMessage = (role, text) => ({
    id: toMessageId(),
    role,
    text: text.slice(0, 1000),
    createdAt: new Date().toISOString(),
});

const pushChatMessage = (session, message) => {
    session.chatMessages.push(message);
    if (session.chatMessages.length > 100) {
        session.chatMessages.shift();
    }

    getSessionSockets(session).forEach((ws) => send(ws, "chat_message", message));
};

const getPool = (session) => {
    const deduped = new Map();
    session.roles
        .flatMap((role) => session.picks[role])
        .forEach((movie) => {
            if (!deduped.has(movie.ID)) deduped.set(movie.ID, movie);
        });

    return Array.from(deduped.values()).filter((movie) => !session.seenMovieIds.has(movie.ID));
};

const nextMovie = (session) => {
    const pool = getPool(session);
    if (!pool.length) {
        finishVoting(session);
        return;
    }

    const preferredUpcoming = session.upcomingMovie
        ? pool.find((movie) => movie.ID === session.upcomingMovie.ID)
        : null;
    const current = preferredUpcoming ?? pool[Math.floor(Math.random() * pool.length)];
    session.currentMovie = current;

    const remaining = pool.filter((movie) => movie.ID !== current.ID);
    session.upcomingMovie = remaining.length > 0
        ? remaining[Math.floor(Math.random() * remaining.length)]
        : null;
    session.phase = "voting";
    resetVotes(session);
};

const detachSocketFromCurrentSession = (socket) => {
    const { code, role } = socket.meta || {};
    if (!code || !role) return;

    const session = sessions.get(code);
    if (!session) return;

    if (session.players[role] === socket) {
        session.players[role] = null;
    }

    if (!getSessionSockets(session).length) {
        sessions.delete(code);
    } else {
        broadcastState(session);
    }
};

wss.on("connection", (socket) => {
    socket.meta = { code: null, role: null };

    socket.on("message", (raw) => {
        let message;
        try {
            message = JSON.parse(String(raw));
        } catch {
            send(socket, "session_error", { message: "Invalid payload" });
            return;
        }

        const { type, payload = {} } = message;

        if (type === "create_session") {
            detachSocketFromCurrentSession(socket);
            let code = toId();
            while (sessions.has(code)) {
                code = toId();
            }

            const participantCount = clampInteger(
                payload.participantCount,
                MIN_PARTICIPANTS,
                MAX_PARTICIPANTS,
                DEFAULT_PARTICIPANTS
            );
            const pickCount = clampInteger(payload.pickCount, MIN_PICK_COUNT, MAX_PICK_COUNT, DEFAULT_PICK_COUNT);
            const mode = getMode(payload.mode);
            const roles = ROLE_NAMES.slice(0, participantCount);
            const session = {
                code,
                participantCount,
                pickCount,
                mode,
                roles,
                phase: "configuring_providers",
                selectedProviderIds: [],
                players: createRoleMap({ roles }, (role) => role === roles[0] ? socket : null),
                picks: createRoleMap({ roles }, () => []),
                votes: createRoleMap({ roles }, () => null),
                currentMovie: null,
                upcomingMovie: null,
                matchedMovie: null,
                matchedMovies: [],
                seenMovieIds: new Set(),
                chatMessages: [],
            };

            sessions.set(code, session);
            socket.meta = { code, role: roles[0] };
            send(socket, "session_created", { code, role: roles[0], participantCount, pickCount, mode });
            send(socket, "chat_history", session.chatMessages);
            broadcastState(session);
            return;
        }

        if (type === "join_session") {
            detachSocketFromCurrentSession(socket);
            const code = String(payload.code || "").replace(/\D/g, "").trim();
            const session = sessions.get(code);

            if (!session) {
                send(socket, "session_error", { message: "Session not found" });
                return;
            }

            const role = session.roles.find((candidate) => !session.players[candidate]);
            if (!role) {
                send(socket, "session_error", { message: "Session is full" });
                return;
            }

            session.players[role] = socket;
            socket.meta = { code, role };
            if (session.phase === "waiting_for_second_user" && session.selectedProviderIds.length > 0 && allPlayersConnected(session)) {
                session.phase = "picking";
            }
            if ((session.phase === "waiting_for_second_user" || session.phase === "picking") && allPlayersConnected(session) && allPicksDone(session)) {
                nextMovie(session);
            }

            send(socket, "session_joined", {
                code,
                role,
                participantCount: session.participantCount,
                pickCount: session.pickCount,
                mode: session.mode,
            });
            send(socket, "chat_history", session.chatMessages);
            broadcastState(session);
            return;
        }

        if (type === "submit_provider_setup") {
            const code = String(payload.code || "").replace(/\D/g, "").trim();
            const role = payload.role;
            const providerIds = sanitizeProviderIds(payload.providerIds);
            const session = sessions.get(code);

            if (!session || !session.roles.includes(role)) return;
            if (session.players[role] !== socket) return;
            if (!isHost(session, role)) {
                send(socket, "session_error", { message: "Only the host can select providers" });
                return;
            }
            if (!providerIds.length) {
                send(socket, "session_error", { message: "Please select at least one provider" });
                return;
            }

            session.selectedProviderIds = providerIds;
            session.phase = allPlayersConnected(session) ? "picking" : "waiting_for_second_user";
            if (allPlayersConnected(session) && allPicksDone(session)) {
                nextMovie(session);
            }
            broadcastState(session);
            return;
        }

        if (type === "submit_picks") {
            const code = String(payload.code || "").replace(/\D/g, "").trim();
            const role = payload.role;
            const movies = Array.isArray(payload.movies) ? payload.movies : [];
            const session = sessions.get(code);

            if (!session || !session.roles.includes(role)) return;
            if (session.players[role] !== socket) return;

            if (session.phase !== "picking" && session.phase !== "waiting_for_second_user") return;
            if (!session.selectedProviderIds.length) return;

            session.picks[role] = movies
                .filter((movie) => String(movie.Type || "Movie") === "Movie")
                .slice(0, session.pickCount)
                .map((movie) => ({
                    ID: Number(movie.ID),
                    Title: String(movie.Title || "Unknown"),
                    PosterUrl: movie.PosterUrl || undefined,
                    BackgroundImageUrl: movie.BackgroundImageUrl || movie.BackdropUrl || movie.Backdrop || undefined,
                    Character: movie.Character || undefined,
                    Year: movie.Year || undefined,
                    Type: movie.Type || undefined,
                    AvailabilityStatus: movie.AvailabilityStatus || undefined,
                }));

            if (allPlayersConnected(session) && allPicksDone(session)) {
                nextMovie(session);
            } else if (allPlayersConnected(session)) {
                session.phase = "picking";
            } else {
                session.phase = "waiting_for_second_user";
            }

            broadcastState(session);
            return;
        }

        if (type === "vote_movie") {
            const code = String(payload.code || "").replace(/\D/g, "").trim();
            const role = payload.role;
            const vote = payload.vote;
            const session = sessions.get(code);

            if (!session || session.phase !== "voting") return;
            if (!session.roles.includes(role)) return;
            if (session.players[role] !== socket) return;
            if (vote !== "yes" && vote !== "no") return;

            session.votes[role] = vote;

            if (allVotesDone(session)) {
                const currentMovie = session.currentMovie;
                const isMatch = session.roles.every((candidate) => session.votes[candidate] === "yes");

                if (isMatch && session.mode === "watch_now") {
                    session.phase = "matched";
                    session.matchedMovie = currentMovie;
                    session.upcomingMovie = null;
                } else {
                    if (isMatch && currentMovie && !session.matchedMovies.some((movie) => movie.ID === currentMovie.ID)) {
                        session.matchedMovies.push(currentMovie);
                    }
                    if (currentMovie?.ID) {
                        session.seenMovieIds.add(currentMovie.ID);
                    }
                    nextMovie(session);
                }
            }

            broadcastState(session);
            return;
        }

        if (type === "send_chat_message") {
            const code = String(payload.code || "").replace(/\D/g, "").trim();
            const role = payload.role;
            const text = String(payload.text || "").trim();
            const session = sessions.get(code);

            if (!session || !session.roles.includes(role)) return;
            if (session.players[role] !== socket) return;
            if (!text) return;

            pushChatMessage(session, createChatMessage(role, text));
            return;
        }

        if (type === "leave_session") {
            detachSocketFromCurrentSession(socket);
            socket.meta = { code: null, role: null };
            send(socket, "session_left", { ok: true });
        }
    });

    socket.on("close", () => {
        const { code, role } = socket.meta || {};
        if (!code || !role) return;

        const session = sessions.get(code);
        if (!session) return;

        if (session.players[role] === socket) {
            session.players[role] = null;
        }

        if (!getSessionSockets(session).length) {
            sessions.delete(code);
            return;
        }

        broadcastState(session);
    });
});

server.listen(PORT, () => {
    //logger.info(`[watch-match] server listening on :${PORT}`);
});
