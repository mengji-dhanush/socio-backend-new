import { redisClient } from "../config/db.js";
import { UserRepository } from "./UserRepository.js";
import { FollowRepository } from "./FollowRepository.js";
import { PostRepository } from "./PostRepository.js";
import dotenv from "dotenv";

dotenv.config();

// Helper to replace S3 URLs with CloudFront CDN URLs if configured
export function resolveCdnUrl(url) {
  if (!url || !process.env.CLOUDFRONT_URL) return url;
  
  // Format matches: https://bucket-name.s3.region.amazonaws.com/key
  const s3Match = url.match(/https?:\/\/[^\/]+\.s3\.[^\/]+\.amazonaws\.com\/(.+)/);
  if (s3Match && s3Match[1]) {
    const key = s3Match[1];
    const cdnBase = process.env.CLOUDFRONT_URL.replace(/\/$/, "");
    return `${cdnBase}/${key}`;
  }
  return url;
}

export const FeedRepository = {
  async pushToFeed(userId, postId, score) {
    const feedKey = `feed:${userId}`;
    await redisClient.zadd(feedKey, score, postId);
    // Keep feed size limited to e.g. 500 items for efficiency
    await redisClient.zremrangebyrank(feedKey, 0, -501);
  },

  async removeFromFeed(userId, postId) {
    await redisClient.zrem(`feed:${userId}`, postId);
  },

  async invalidateFeed(userId) {
    await redisClient.del(`feed:${userId}`);
  },

  async getFeed(userId, page = 1, limit = 10) {
    const feedKey = `feed:${userId}`;
    const start = (page - 1) * limit;
    const stop = page * limit - 1;

    // 1. Try to read post IDs from Redis sorted set
    let postIds = await redisClient.zrevrange(feedKey, start, stop);

    // 2. Cache Miss or Empty Cache: Pull Approach
    if (!postIds || postIds.length === 0) {
      console.log(`Feed cache miss for user ${userId}. Rebuilding feed from databases (Pull).`);
      
      // Retrieve list of users followed by this user
      const following = await FollowRepository.getFollowing(userId);
      const followingIds = following.map((u) => u.id);
      followingIds.push(userId); // Always include own posts in feed

      // Fetch their recent posts from DynamoDB
      const posts = await PostRepository.listByUserIds(followingIds);
      
      // Write posts to Redis to warm cache
      for (const post of posts) {
        await redisClient.zadd(feedKey, post.createdAt, post.postId);
      }
      await redisClient.zremrangebyrank(feedKey, 0, -501); // cap size

      // Re-query range
      postIds = await redisClient.zrevrange(feedKey, start, stop);
    }

    // 3. Batch load post details from DynamoDB
    const resultPosts = [];
    for (const pid of postIds) {
      const post = await PostRepository.getById(pid);
      if (post) {
        // Resolve owner details from PostgreSQL
        const owner = await UserRepository.getByEmail(post.ownerEmail) || await UserRepository.getById(post.ownerId);
        resultPosts.push({
          ...post,
          owner: owner ? {
            id: owner.id,
            username: owner.username,
            email: owner.email,
            name: owner.name,
            profilePhoto: owner.profilePhoto ? {
              ...owner.profilePhoto,
              url: resolveCdnUrl(owner.profilePhoto.url),
            } : { url: "/utilities/SocioLogo.png" }
          } : { username: "unknown", email: post.ownerEmail, profilePhoto: { url: "/utilities/SocioLogo.png" } }
        });
      }
    }

    return this.applyCdnToPosts(resultPosts);
  },

  // Helper utility to process and apply CDN conversion to images
  applyCdnToPosts(posts) {
    return posts.map((post) => {
      const updatedPost = { ...post };
      if (updatedPost.image?.url) {
        updatedPost.image = {
          ...updatedPost.image,
          url: resolveCdnUrl(updatedPost.image.url),
        };
      }
      if (updatedPost.owner?.profilePhoto?.url) {
        updatedPost.owner.profilePhoto = {
          ...updatedPost.owner.profilePhoto,
          url: resolveCdnUrl(updatedPost.owner.profilePhoto.url),
        };
      }
      return updatedPost;
    });
  }
};
