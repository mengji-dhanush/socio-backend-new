import express from "express";
import multer from "multer";
import { v4 as uuid } from "uuid";
import cors from "cors";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";

// Database initialization
import { 
  initializePostgresDatabase, 
  s3Client 
} from "./config/db.js";

// Repository Layer imports
import { UserRepository } from "./repositories/UserRepository.js";
import { FollowRepository } from "./repositories/FollowRepository.js";
import { PostRepository } from "./repositories/PostRepository.js";
import { CommentRepository } from "./repositories/CommentRepository.js";
import { ChatRepository } from "./repositories/ChatRepository.js";
import { FeedRepository, resolveCdnUrl } from "./repositories/FeedRepository.js";
import { Upload } from "@aws-sdk/lib-storage";

dotenv.config();

// ---------------- App Setup ----------------
const app = express();
const PORT = process.env.PORT || 5000;

// ---------------- Middleware ----------------
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Multer (file uploads memory)
const uploadProfiles = multer({ storage: multer.memoryStorage() });
const uploadPosts = multer({ storage: multer.memoryStorage() });

async function uploadToS3(file, folder) {
  const fileKey = `${folder}/${uuid()}-${file.originalname}`;

  try {
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: fileKey,
        Body: file.buffer,
        ContentType: file.mimetype,
      },
    });

    const result = await upload.done();
    if (result.Location) return result.Location;
    return `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileKey}`;
  } catch (err) {
    console.error("S3 Upload failed:", err.message);
    throw err;
  }
}

// ---------------- JWT & Auth Middlewares ----------------
function isLoggedIn(req, res, next) {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // {email, userId, role, iat, exp}
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Role-Based Access Control (RBAC) middleware
function authorizeRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden: Insufficient permissions" });
    }
    next();
  };
}

// ---------------- AUTH ROUTES ----------------

app.post("/signup", async (req, res) => {
  try {
    const { username, email, password, name, dob, role } = req.body;
    if (!email || !password || !username) {
      return res.status(400).json({ error: "Username, email & password required" });
    }

    const existing = await UserRepository.getByEmail(email);
    if (existing) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuid();

    const newUser = {
      id: userId,
      username,
      email,
      password: hashedPassword,
      name,
      dob,
      bio: "",
      profilePhoto: null,
      role: role || "student", // default role is student
      createdAt: Date.now(),
    };

    await UserRepository.create(newUser);

    const token = jwt.sign(
      { email, userId, role: newUser.role },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.cookie("token", token, {
      httpOnly: true,
      secure: false, // development
      sameSite: "lax",
      maxAge: 60 * 60 * 1000,
    });

    const { password: _pw, ...safeUser } = newUser;
    res.json({ success: true, user: safeUser });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email & password required" });
    }

    const user = await UserRepository.getByEmail(email);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { email: user.email, userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.cookie("token", token, {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: 60 * 60 * 1000,
    });

    const { password: _pw, ...safeUser } = user;
    // Apply CloudFront CDN resolver to profile photo if exists
    if (safeUser.profilePhoto?.url) {
      safeUser.profilePhoto.url = resolveCdnUrl(safeUser.profilePhoto.url);
    }
    res.json({ success: true, user: safeUser });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/logout", isLoggedIn, (req, res) => {
  res.clearCookie("token");
  res.json({ success: true });
});

app.get("/me", isLoggedIn, async (req, res) => {
  try {
    const user = await UserRepository.getById(req.user.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    
    const { password: _pw, ...safeUser } = user;
    if (safeUser.profilePhoto?.url) {
      safeUser.profilePhoto.url = resolveCdnUrl(safeUser.profilePhoto.url);
    }
    res.json(safeUser);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user profile details by ID/Email
app.get("/users/:idOrEmail", isLoggedIn, async (req, res) => {
  try {
    const term = req.params.idOrEmail;
    let user = null;
    if (term.includes("@")) {
      user = await UserRepository.getByEmail(term);
    } else {
      user = await UserRepository.getById(term);
    }
    if (!user) return res.status(404).json({ error: "User not found" });

    const { password: _pw, ...safeUser } = user;
    if (safeUser.profilePhoto?.url) {
      safeUser.profilePhoto.url = resolveCdnUrl(safeUser.profilePhoto.url);
    }

    // Include followers stats
    const followers = await FollowRepository.getFollowers(safeUser.id);
    const following = await FollowRepository.getFollowing(safeUser.id);
    const isFollowing = await FollowRepository.isFollowing(req.user.userId, safeUser.id);

    res.json({
      user: safeUser,
      followersCount: followers.length,
      followingCount: following.length,
      isFollowing,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all users (useful for chat / follow suggestions)
app.get("/users", isLoggedIn, async (req, res) => {
  try {
    const allUsers = await UserRepository.listAll();
    const cleanUsers = allUsers.map(({ password, ...u }) => {
      if (u.profilePhoto?.url) {
        u.profilePhoto.url = resolveCdnUrl(u.profilePhoto.url);
      }
      return u;
    });
    res.json(cleanUsers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- PROFILE ROUTES ----------------
app.post(
  "/profile/edit",
  isLoggedIn,
  uploadProfiles.single("profilePhoto"),
  async (req, res) => {
    try {
      const { bio } = req.body;
      let profilePhoto = null;

      if (req.file) {
        const url = await uploadToS3(req.file, "profiles");
        profilePhoto = { fileName: req.file.originalname, url };
      }

      await UserRepository.updateBioAndPhoto(req.user.email, bio, profilePhoto);
      res.json({ success: true });
    } catch (err) {
      console.error("Profile edit error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ---------------- FOLLOW / UNFOLLOW ----------------

app.post("/users/:id/follow", isLoggedIn, async (req, res) => {
  try {
    if (req.user.userId === req.params.id) {
      return res.status(400).json({ error: "Cannot follow yourself" });
    }
    await FollowRepository.follow(req.user.userId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/users/:id/unfollow", isLoggedIn, async (req, res) => {
  try {
    await FollowRepository.unfollow(req.user.userId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/users/:id/followers", isLoggedIn, async (req, res) => {
  try {
    const list = await FollowRepository.getFollowers(req.params.id);
    res.json(list.map(({ password, ...u }) => u));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/users/:id/following", isLoggedIn, async (req, res) => {
  try {
    const list = await FollowRepository.getFollowing(req.params.id);
    res.json(list.map(({ password, ...u }) => u));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/users/:id/is-following", isLoggedIn, async (req, res) => {
  try {
    const result = await FollowRepository.isFollowing(req.user.userId, req.params.id);
    res.json({ isFollowing: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- POST ROUTES ----------------

// 1. Personalized Feed Route with Pagination (Infinite Scroll)
app.get("/posts/feed", isLoggedIn, async (req, res) => {
  try {
    const page = parseInt(req.query.page || "1", 10);
    const limit = parseInt(req.query.limit || "10", 10);

    const posts = await FeedRepository.getFeed(req.user.userId, page, limit);
    res.json(posts);
  } catch (err) {
    console.error("Get feed error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Discover/All Posts Route
app.get("/posts", isLoggedIn, async (req, res) => {
  try {
    const posts = await PostRepository.listAll();
    // Resolve post owners
    const resolvedPosts = [];
    for (const post of posts) {
      const owner = await UserRepository.getByEmail(post.ownerEmail) || await UserRepository.getById(post.ownerId);
      resolvedPosts.push({
        ...post,
        image: post.image ? { ...post.image, url: resolveCdnUrl(post.image.url) } : null,
        owner: owner ? {
          id: owner.id,
          username: owner.username,
          email: owner.email,
          name: owner.name,
          profilePhoto: owner.profilePhoto ? {
            ...owner.profilePhoto,
            url: resolveCdnUrl(owner.profilePhoto.url)
          } : { url: "/utilities/SocioLogo.png" }
        } : { username: "unknown", email: post.ownerEmail, profilePhoto: { url: "/utilities/SocioLogo.png" } }
      });
    }
    res.json(resolvedPosts);
  } catch (err) {
    console.error("Get posts error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/posts/:postId", isLoggedIn, async (req, res) => {
  try {
    const postId = req.params.postId;
    const post = await PostRepository.getById(postId);
    if (!post) return res.status(404).json({ error: "Post not found" });

    // Prepend CDN if needed
    if (post.image?.url) {
      post.image.url = resolveCdnUrl(post.image.url);
    }

    const owner = await UserRepository.getByEmail(post.ownerEmail) || await UserRepository.getById(post.ownerId);
    post.owner = owner ? {
      id: owner.id,
      username: owner.username,
      email: owner.email,
      name: owner.name,
      profilePhoto: owner.profilePhoto ? {
        ...owner.profilePhoto,
        url: resolveCdnUrl(owner.profilePhoto.url),
      } : { url: "/utilities/SocioLogo.png" }
    } : { username: "unknown", email: post.ownerEmail, profilePhoto: { url: "/utilities/SocioLogo.png" } };

    // Get Comments
    const rawComments = await CommentRepository.listByPostId(postId);
    const resolvedComments = [];
    for (const c of rawComments) {
      const author = await UserRepository.getByEmail(c.authorEmail) || await UserRepository.getById(c.authorId || "");
      resolvedComments.push({
        ...c,
        author: author ? {
          id: author.id,
          username: author.username,
          email: author.email,
          profilePhoto: author.profilePhoto ? {
            ...author.profilePhoto,
            url: resolveCdnUrl(author.profilePhoto.url)
          } : { url: "/utilities/SocioLogo.png" }
        } : { username: "unknown", email: c.authorEmail, profilePhoto: { url: "/utilities/SocioLogo.png" } }
      });
    }

    res.json({ ...post, comments: resolvedComments });
  } catch (err) {
    console.error("Get post details error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post(
  "/posts/new",
  isLoggedIn,
  uploadPosts.single("postImage"),
  async (req, res) => {
    try {
      const { content } = req.body;
      const postId = uuid();
      const createdAt = Date.now();
      let image = null;

      if (req.file) {
        const url = await uploadToS3(req.file, "posts");
        image = { fileName: req.file.originalname, url };
      }

      const newPost = {
        postId,
        createdAt,
        ownerEmail: req.user.email,
        ownerId: req.user.userId,
        content,
        image,
      };

      await PostRepository.create(newPost);
      res.json({ success: true, postId });
    } catch (err) {
      console.error("Create post error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

app.put("/posts/:id", isLoggedIn, async (req, res) => {
  try {
    const { content } = req.body;
    const postId = req.params.id;

    const post = await PostRepository.getById(postId);
    if (!post) return res.status(404).json({ error: "Post not found" });

    // Ownership check or Admin/Faculty check (RBAC)
    if (post.ownerEmail !== req.user.email && req.user.role !== "admin" && req.user.role !== "faculty") {
      return res.status(403).json({ error: "Not authorized" });
    }

    await PostRepository.updateContent(postId, content);
    res.json({ success: true });
  } catch (err) {
    console.error("Update post error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Delete post: Protected by RBAC (Authors, Faculty, Admin can delete)
app.delete("/posts/:id", isLoggedIn, async (req, res) => {
  try {
    const postId = req.params.id;
    const post = await PostRepository.getById(postId);
    if (!post) return res.status(404).json({ error: "Post not found" });

    // RBAC ownership check
    if (post.ownerEmail !== req.user.email && req.user.role !== "admin" && req.user.role !== "faculty") {
      return res.status(403).json({ error: "Not authorized (Forbidden)" });
    }

    await PostRepository.delete(postId);
    res.json({ success: true });
  } catch (err) {
    console.error("Delete post error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------- COMMENT ROUTES ----------------
app.post("/posts/:id/comment", isLoggedIn, async (req, res) => {
  try {
    const { content } = req.body;
    const commentId = uuid();
    const createdAt = Date.now();

    const comment = {
      commentId,
      postId: req.params.id,
      authorEmail: req.user.email,
      authorId: req.user.userId,
      content,
      createdAt,
    };

    await CommentRepository.create(comment);

    // Fetch the updated post details and return
    res.redirect(307, `/posts/${req.params.id}`);
  } catch (err) {
    console.error("Create comment error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/comments/:id", isLoggedIn, async (req, res) => {
  try {
    const commentId = req.params.id;
    const comment = await CommentRepository.getById(commentId);
    if (!comment) return res.status(404).json({ error: "Comment not found" });

    // RBAC: Author, Post Owner, Faculty, or Admin can delete comment
    const post = await PostRepository.getById(comment.postId);
    const isPostOwner = post && post.ownerEmail === req.user.email;
    const isAuthor = comment.authorEmail === req.user.email;
    const isModerator = req.user.role === "admin" || req.user.role === "faculty";

    if (!isAuthor && !isPostOwner && !isModerator) {
      return res.status(403).json({ error: "Not authorized to delete comment" });
    }

    await CommentRepository.delete(commentId);
    res.json({ success: true });
  } catch (err) {
    console.error("Delete comment error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------- CHAT LOGS ROUTE ----------------
app.get("/chat/history/:userId", isLoggedIn, async (req, res) => {
  try {
    const otherUserId = req.params.userId;
    const currentUserId = req.user.userId;
    const room = [currentUserId, otherUserId].sort().join("_");
    const history = await ChatRepository.getHistory(room);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Start Server & WebSockets ----------------
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  initializePostgresDatabase();
});

const wss = new WebSocketServer({ server });
const activeConnections = new Map();

wss.on("connection", async (ws, req) => {
  try {
    // Read cookies from WS headers
    const cookieHeader = req.headers.cookie || "";
    const tokenCookie = cookieHeader.split(";").find((c) => c.trim().startsWith("token="));
    let token = null;

    if (tokenCookie) {
      token = tokenCookie.split("=")[1];
    } else {
      const urlParams = new URL(req.url, "http://localhost");
      token = urlParams.searchParams.get("token");
    }

    if (!token) {
      ws.close(4001, "Unauthorized");
      return;
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.userId;
    ws.userId = userId;

    if (!activeConnections.has(userId)) {
      activeConnections.set(userId, new Set());
    }
    activeConnections.get(userId).add(ws);
    console.log(`WebSocket user connected: ${userId}`);

    ws.on("message", async (msgStr) => {
      try {
        const data = JSON.parse(msgStr);
        if (data.type === "chat") {
          const { receiverId, message } = data;
          if (!receiverId || !message) return;

          const chatItem = {
            chatId: uuid(),
            room: [userId, receiverId].sort().join("_"),
            senderId: userId,
            receiverId,
            message,
            createdAt: Date.now(),
          };

          await ChatRepository.saveMessage(chatItem);

          // Route to receiver if online
          const receiverSocks = activeConnections.get(receiverId);
          if (receiverSocks) {
            receiverSocks.forEach((socket) => {
              if (socket.readyState === ws.OPEN) {
                socket.send(JSON.stringify({
                  type: "chat",
                  ...chatItem,
                }));
              }
            });
          }

          // Echo confirmation back to sender
          ws.send(JSON.stringify({
            type: "chat_echo",
            chatItem,
          }));
        }
      } catch (err) {
        console.error("WS message handle error:", err.message);
      }
    });

    ws.on("close", () => {
      const socks = activeConnections.get(userId);
      if (socks) {
        socks.delete(ws);
        if (socks.size === 0) activeConnections.delete(userId);
      }
      console.log(`WebSocket user disconnected: ${userId}`);
    });
  } catch (err) {
    console.error("WebSocket handshaking failed:", err.message);
    ws.close(4002, "Auth verification failed");
  }
});
