const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3001);

const sessions = new Map();

const createCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();

const safeSend = (socket, type, payload = {}) => {
    if (!socket || socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify({ type, payload }));
};

const getSessionState = (session) => ({
    code: session.code,
    phase: session.phase,
    currentMovie: session.currentMovie,
    matchedMovie: session.matchedMovie,
    picksDone: {
        a: session.picks.a.length === 5,
        b: session.picks.b.length === 5,
    },
    usersReady: {
        a: Boolean(session.players.a),
        b: Boolean(session.players.b),
    },
});

const broadcastState = (session) => {
    const statePayload = getSessionState(session);
    safeSend(session.players.a, "session_state", statePayload);
    safeSend(session.players.b, "session_state", statePayload);
};

const getMoviePool = (session) => {
    const deduped = new Map();

    [...session.picks.a, ...session.picks.b].forEach((movie) => {
        if (!deduped.has(movie.ID)) {
            deduped.set(movie.ID, movie);
        }
    });

    return Array.from(deduped.values()).filter((movie) => !session.seenMovieIds.has(movie.ID));
};

const setNextMovie = (session) => {
    const pool = getMoviePool(session);

    if (!pool.length) {
        session.phase = "finished_no_match";
        session.currentMovie = null;
        return;
    }

    const randomIndex = Math.floor(Math.random() * pool.length);
    session.currentMovie = pool[randomIndex];
    session.phase = "voting";
    session.votes = { a: null, b: null };
};

const normalizeMovies = (movies) => {
    const deduped = new Map();

    (Array.isArray(movies) ? movies : []).forEach((movie) => {
        const id = Number(movie?.ID);
        const title = String(movie?.Title || "").trim();
        if (!id || !title) return;

        deduped.set(id, {
            ID: id,
            Title: title,
            PosterUrl: movie?.PosterUrl ? String(movie.PosterUrl) : undefined,
            Year: movie?.Year,
        });
    });

    return Array.from(deduped.values()).slice(0, 5);
};

const server = http.createServer((req, res) => {
    if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Watch Match websocket server is running.");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
    socket.meta = { code: null, role: null };

    socket.on("message", (raw) => {
        let message;

        try {
            message = JSON.parse(String(raw));
        } catch {
            safeSend(socket, "session_error", { message: "Invalid payload" });
            return;
        }

        const { type, payload = {} } = message;

        if (type === "create_session") {
            const code = createCode();
            const session = {
                code,
                phase: "waiting_for_second_user",
                players: { a: socket, b: null },
                picks: { a: [], b: [] },
                votes: { a: null, b: null },
                currentMovie: null,
                matchedMovie: null,
                seenMovieIds: new Set(),
            };

            sessions.set(code, session);
            socket.meta = { code, role: "a" };
            safeSend(socket, "session_created", { code, role: "a" });
            broadcastState(session);
            return;
        }

        if (type === "join_session") {
            const code = String(payload.code || "").trim().toUpperCase();
            const session = sessions.get(code);

            if (!session) {
                safeSend(socket, "session_error", { message: "Session not found" });
                return;
            }

            if (session.players.b) {
                safeSend(socket, "session_error", { message: "Session is full" });
                return;
            }

            session.players.b = socket;
            socket.meta = { code, role: "b" };

            if (session.phase === "waiting_for_second_user") {
                session.phase = "picking";
            }

            safeSend(socket, "session_joined", { code, role: "b" });
            broadcastState(session);
            return;
        }

        if (type === "submit_picks") {
            const code = String(payload.code || "").trim().toUpperCase();
            const role = payload.role;
            const session = sessions.get(code);

            if (!session || (role !== "a" && role !== "b")) return;

            session.picks[role] = normalizeMovies(payload.movies);

            if (session.picks.a.length === 5 && session.picks.b.length === 5) {
                setNextMovie(session);
            } else {
                session.phase = "picking";
            }

            broadcastState(session);
            return;
        }

        if (type === "vote_movie") {
            const code = String(payload.code || "").trim().toUpperCase();
            const role = payload.role;
            const vote = payload.vote;
            const session = sessions.get(code);

            if (!session || session.phase !== "voting") return;
            if (role !== "a" && role !== "b") return;
            if (vote !== "yes" && vote !== "no") return;

            session.votes[role] = vote;

            if (session.votes.a && session.votes.b) {
                if (session.votes.a === "yes" && session.votes.b === "yes") {
                    session.phase = "matched";
                    session.matchedMovie = session.currentMovie;
                } else {
                    if (session.currentMovie?.ID) {
                        session.seenMovieIds.add(session.currentMovie.ID);
                    }
                    setNextMovie(session);
                }
            }

            broadcastState(session);
        }
    });

    socket.on("close", () => {
        const { code, role } = socket.meta || {};
        if (!code || !role) return;

        const session = sessions.get(code);
        if (!session) return;

        if (role === "a") session.players.a = null;
        if (role === "b") session.players.b = null;

        if (!session.players.a && !session.players.b) {
            sessions.delete(code);
            return;
        }

        broadcastState(session);
    });
});

server.listen(PORT, () => {
    console.log(`[watch-match-server] listening on :${PORT}`);
});
