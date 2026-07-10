import { ddbDocClient } from "../config/db.js";
import { PutCommand, GetCommand, DeleteCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { FeedRepository } from "./FeedRepository.js";
import { FollowRepository } from "./FollowRepository.js";

const TABLE_NAME = "Posts";

export const PostRepository = {
  async create(post) {
    await ddbDocClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: post,
      })
    );

    // Fan out to followers using Redis cache via FeedRepository
    const followers = await FollowRepository.getFollowers(post.ownerId || post.ownerEmail);
    for (const follower of followers) {
      await FeedRepository.pushToFeed(follower.id, post.postId, post.createdAt);
    }
    // Also push to own posts list
    await FeedRepository.pushToFeed(post.ownerId, post.postId, post.createdAt);

    return post;
  },

  async getById(postId) {
    const result = await ddbDocClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { postId },
      })
    );
    return result.Item || null;
  },

  async delete(postId) {
    // Find the item first to know owner ID for cache invalidation
    const post = await this.getById(postId);
    
    await ddbDocClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { postId },
      })
    );

    if (post) {
      // Remove from followers' feed caches
      const followers = await FollowRepository.getFollowers(post.ownerId || post.ownerEmail);
      for (const follower of followers) {
        await FeedRepository.removeFromFeed(follower.id, postId);
      }
      await FeedRepository.removeFromFeed(post.ownerId, postId);
    }

    return true;
  },

  async updateContent(postId, content) {
    await ddbDocClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { postId },
        UpdateExpression: "SET content = :content",
        ExpressionAttributeValues: {
          ":content": content,
        },
      })
    );
    return true;
  },

  async listAll() {
    const result = await ddbDocClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
      })
    );
    const items = result.Items || [];
    return items.sort((a, b) => b.createdAt - a.createdAt);
  },

  async listByUserIds(userIds) {
    if (userIds.length === 0) return [];
    
    // In DynamoDB we scan with a filter since userIds is an array
    const filterExprs = [];
    const exprValues = {};
    
    userIds.forEach((uid, idx) => {
      filterExprs.push(`ownerId = :uid${idx} OR ownerEmail = :uid${idx}`);
      exprValues[`:uid${idx}`] = uid;
    });

    const filterExpression = filterExprs.join(" OR ");
    
    const result = await ddbDocClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: filterExpression,
        ExpressionAttributeValues: exprValues,
      })
    );
    const items = result.Items || [];
    return items.sort((a, b) => b.createdAt - a.createdAt);
  }
};
