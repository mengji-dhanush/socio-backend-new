import pg from "pg";
import Redis from "ioredis";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

// 1. PostgreSQL pool
export const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// 2. Redis client
export const redisClient = new Redis(process.env.REDIS_URL);

// 3. DynamoDB Client
const awsConfig = {
  region: process.env.AWS_REGION || "ap-south-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
};

const ddbClient = new DynamoDBClient(awsConfig);
export const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);

// 4. S3 Client
export const s3Client = new S3Client(awsConfig);

// Function to run SQL schema creation on startup
export async function initializePostgresDatabase() {
  try {
    const client = await pgPool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
            id VARCHAR(36) PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            name VARCHAR(100) NOT NULL,
            dob VARCHAR(50),
            bio TEXT DEFAULT '',
            profile_photo VARCHAR(500),
            role VARCHAR(20) DEFAULT 'student',
            created_at BIGINT NOT NULL
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS follows (
            follower_id VARCHAR(36) NOT NULL,
            following_id VARCHAR(36) NOT NULL,
            created_at BIGINT NOT NULL,
            PRIMARY KEY (follower_id, following_id),
            FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
        );
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);`);
      console.log("PostgreSQL tables checked/created successfully.");
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Failed to run schema setup on Postgres:", err.message);
  }
}
