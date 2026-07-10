import { pgPool } from "../config/db.js";
import { UserRepository } from "./UserRepository.js";
import { FeedRepository } from "./FeedRepository.js";

export const FollowRepository = {
  async follow(followerId, followingId) {
    await pgPool.query(
      "INSERT INTO follows (follower_id, following_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [followerId, followingId, Date.now()]
    );
    await FeedRepository.invalidateFeed(followerId);
    return true;
  },

  async unfollow(followerId, followingId) {
    await pgPool.query(
      "DELETE FROM follows WHERE follower_id = $1 AND following_id = $2",
      [followerId, followingId]
    );
    await FeedRepository.invalidateFeed(followerId);
    return true;
  },

  async isFollowing(followerId, followingId) {
    const { rows } = await pgPool.query(
      "SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2",
      [followerId, followingId]
    );
    return rows.length > 0;
  },

  async getFollowers(userId) {
    const { rows } = await pgPool.query(
      "SELECT follower_id FROM follows WHERE following_id = $1",
      [userId]
    );
    const followers = [];
    for (const row of rows) {
      const u = await UserRepository.getById(row.follower_id);
      if (u) followers.push(u);
    }
    return followers;
  },

  async getFollowing(userId) {
    const { rows } = await pgPool.query(
      "SELECT following_id FROM follows WHERE follower_id = $1",
      [userId]
    );
    const following = [];
    for (const row of rows) {
      const u = await UserRepository.getById(row.following_id);
      if (u) following.push(u);
    }
    return following;
  }
};
