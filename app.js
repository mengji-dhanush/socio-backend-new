import express from "express";
import multer from "multer";
import { v4 as uuid } from "uuid";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import cors from "cors";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

// ---------------- App Setup ----------------
const app = express();
const PORT = process.env.PORT || 5000;

// ---------------- AWS Setup (v3) ----------------
// Force credentials from process.env to avoid provider errors

// ---------------- AWS Setup (v3) ----------------
const client = new DynamoDBClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

export const docClient = DynamoDBDocumentClient.from(client);

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// const Redis = require("ioredis");
// const redis = new Redis({ /* ... */ }); // left commented

// ---------------- Middleware ----------------
app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Multer (file uploads memory)
const uploadProfiles = multer({ storage: multer.memoryStorage() });
const uploadPosts = multer({ storage: multer.memoryStorage() });

// ---------------- Helper: Upload to S3 ----------------
async function uploadToS3(file, folder) {
  const fileKey = `${folder}/${uuid()}-${file.originalname}`;

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: fileKey,
      Body: file.buffer,
      ContentType: file.mimetype,
    },
  });

  const result = await upload.done();
  // result.Location is usually present when using Upload
  if (result.Location) return result.Location;

  // fallback construct public url
  return `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileKey}`;
}

// ---------------- JWT Middleware ----------------
function isLoggedIn(req, res, next) {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // {email, userId, iat, exp}
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ---------------- AUTH ROUTES ----------------
// NOTE: Users table primary key: email (String)
app.post("/signup", async (req, res) => {
  try {
    const { email, password, name, dob } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email & password required" });

    // Check existing user by PK (fast)
    const existing = await docClient.send(
      new GetCommand({
        TableName: "Users",
        Key: { email },
      })
    );
    if (existing.Item)
      return res.status(400).json({ error: "Email already registered" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuid();

    await docClient.send(
      new PutCommand({
        TableName: "Users",
        Item: {
          email, // primary key
          userId,
          name,
          dob,
          password: hashedPassword,
          bio: "",
          profilePhoto: null,
          createdAt: Date.now(),
        },
      })
    );

    const token = jwt.sign({ email, userId }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    res.cookie("token", token, {
      httpOnly: true,
      secure: false, // local dev (no HTTPS)
      sameSite: "lax", // send cookie on same-origin navigation + API calls
      maxAge: 60 * 60 * 1000,
    });

    res.json({ success: true, user: { email, userId, name } });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email & password required" });

    // Get user by email (fast)
    const userResp = await docClient.send(
      new GetCommand({
        TableName: "Users",
        Key: { email },
      })
    );

    if (!userResp.Item)
      return res.status(404).json({ error: "User not found" });

    const user = userResp.Item;
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { email: user.email, userId: user.userId },
      process.env.JWT_SECRET,
      {
        expiresIn: "1h",
      }
    );

    res.cookie("token", token, {
      httpOnly: true,
      secure: false, // local dev (no HTTPS)
      sameSite: "lax", // send cookie on same-origin navigation + API calls
      maxAge: 60 * 60 * 1000,
    });

    // Do not send hashed password back
    const { password: _pw, ...safeUser } = user;
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

app.get("/me", isLoggedIn, (req, res) => {
  try {
    res.json({ user: req.user });
  } catch (err) {
    res.status(err.status).json({ error: err.message });
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
      let profilePhotoUrl = null;

      if (req.file) {
        profilePhotoUrl = await uploadToS3(req.file, "profiles");
      }

      const updateExpr = profilePhotoUrl
        ? "SET bio = :bio, profilePhoto = :photo"
        : "SET bio = :bio";

      const exprAttrValues = profilePhotoUrl
        ? { ":bio": bio, ":photo": profilePhotoUrl }
        : { ":bio": bio };

      // Users table key is email
      await docClient.send(
        new UpdateCommand({
          TableName: "Users",
          Key: { email: req.user.email },
          UpdateExpression: updateExpr,
          ExpressionAttributeValues: exprAttrValues,
        })
      );

      res.json({ success: true });
    } catch (err) {
      console.error("Profile edit error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ---------------- POST ROUTES ----------------
// Note: Posts table schema assumed: PartitionKey=postId (S), optional sortKey=createdAt (N).
// This code stores createdAt; when updating/deleting we first scan to find the item and its sort key if present.

app.get("/posts", isLoggedIn, async (req, res) => {
  try {
    const postsData = await docClient.send(
      new ScanCommand({ TableName: "Posts" })
    );
    console.log("Posts from API:", postsData.Items);
    res.json(postsData.Items || []);
  } catch (err) {
    console.error("Get posts error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/posts/:id", isLoggedIn, async (req, res) => {
  try {
    const postId = req.params.postId;
    // find by postId (Scan). If your table has queryable keys, replace with Query.
    const postsData = await docClient.send(
      new ScanCommand({
        TableName: "Posts",
        FilterExpression: "postId = :pid",
        ExpressionAttributeValues: { ":pid": postId },
      })
    );

    const item = (postsData.Items && postsData.Items[0]) || null;
    if (!item) return res.status(404).json({ error: "Post not found" });

    // get comments
    const commentsData = await docClient.send(
      new ScanCommand({
        TableName: "Comments",
        FilterExpression: "postId = :pid",
        ExpressionAttributeValues: { ":pid": postId },
      })
    );

    res.json({ ...item, comments: commentsData.Items || [] });
  } catch (err) {
    console.error("Get post error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post(
  "/posts/new",
  isLoggedIn,
  uploadPosts.single("postImage"),
  async (req, res) => {
    try {
      console.log("req.user:", req.user);
      const { content } = req.body;
      const postId = uuid();
      const createdAt = Date.now(); // number
      let image = null;

      if (req.file) {
        const url = await uploadToS3(req.file, "posts");
        image = { fileName: req.file.originalname, url };
      }

      // store ownerEmail to reference owner
      await docClient.send(
        new PutCommand({
          TableName: "Posts",
          Item: {
            postId,
            createdAt,
            ownerEmail: req.user.email,
            content,
            image,
          },
        })
      );

      res.json({ success: true, postId });
    } catch (err) {
      console.error("Create post error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Update post: find item (to get createdAt key if table uses composite key), check ownership, then update
app.put("/posts/:id", isLoggedIn, async (req, res) => {
  try {
    const { content } = req.body;
    const postId = req.params.id;

    // find post
    const found = await docClient.send(
      new ScanCommand({
        TableName: "Posts",
        FilterExpression: "postId = :pid",
        ExpressionAttributeValues: { ":pid": postId },
      })
    );

    const item = (found.Items && found.Items[0]) || null;
    if (!item) return res.status(404).json({ error: "Post not found" });

    if (item.ownerEmail !== req.user.email)
      return res.status(403).json({ error: "Not authorized" });

    // determine key (if createdAt present, include it)
    const key = item.createdAt
      ? { postId: item.postId, createdAt: item.createdAt }
      : { postId: item.postId };

    await docClient.send(
      new UpdateCommand({
        TableName: "Posts",
        Key: key,
        UpdateExpression: "SET content = :content",
        ExpressionAttributeValues: { ":content": content },
      })
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Update post error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Delete post: find it first (to get full key & S3 url if we want to delete file)
app.delete("/posts/:id", isLoggedIn, async (req, res) => {
  try {
    const postId = req.params.id;

    const found = await docClient.send(
      new ScanCommand({
        TableName: "Posts",
        FilterExpression: "postId = :pid",
        ExpressionAttributeValues: { ":pid": postId },
      })
    );

    const item = (found.Items && found.Items[0]) || null;
    if (!item) return res.status(404).json({ error: "Post not found" });

    if (item.ownerEmail !== req.user.email)
      return res.status(403).json({ error: "Not authorized" });

    // *** delete from S3 ***

    const key = item.createdAt
      ? { postId: item.postId, createdAt: item.createdAt }
      : { postId: item.postId };

    await docClient.send(
      new DeleteCommand({
        TableName: "Posts",
        Key: key,
      })
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Delete post error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Search posts (simple scan + filter)

// app.get("/posts/search", isLoggedIn, async (req, res) => {
//   try {
//     const query = req.query.q?.toLowerCase() || "";
//     const postsData = await docClient.send(
//       new ScanCommand({ TableName: "Posts" })
//     );

//     const posts = (postsData.Items || []).filter((p) =>
//       String(p.content || "")
//         .toLowerCase()
//         .includes(query)
//     );

//     res.json(posts);
//   } catch (err) {
//     console.error("Search posts error:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

// // ---------------- COMMENT ROUTES ----------------
// app.post("/posts/:id/comment", isLoggedIn, async (req, res) => {
//   try {
//     const { content } = req.body;
//     const commentId = uuid();
//     const createdAt = Date.now();

//     await docClient.send(
//       new PutCommand({
//         TableName: "Comments",
//         Item: {
//           commentId,
//           postId: req.params.id,
//           authorEmail: req.user.email,
//           content,
//           createdAt,
//         },
//       })
//     );

//     res.json({ success: true, commentId });
//   } catch (err) {
//     console.error("Create comment error:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

// app.delete("/comments/:id", isLoggedIn, async (req, res) => {
//   try {
//     const commentId = req.params.id;
//     const commentData = await docClient.send(
//       new GetCommand({
//         TableName: "Comments",
//         Key: { commentId },
//       })
//     );

//     if (!commentData.Item)
//       return res.status(404).json({ error: "Comment not found" });
//     if (commentData.Item.authorEmail !== req.user.email)
//       return res.status(403).json({ error: "Not authorized" });

//     await docClient.send(
//       new DeleteCommand({
//         TableName: "Comments",
//         Key: { commentId },
//       })
//     );
//     res.json({ success: true });
//   } catch (err) {
//     console.error("Delete comment error:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

// ---------------- Start Server ----------------
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
