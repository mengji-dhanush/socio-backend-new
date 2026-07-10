import { ddbDocClient } from "../config/db.js";
import { PutCommand, GetCommand, DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = "Comments";

export const CommentRepository = {
  async create(comment) {
    await ddbDocClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: comment,
      })
    );
    return comment;
  },

  async delete(commentId) {
    await ddbDocClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { commentId },
      })
    );
    return true;
  },

  async getById(commentId) {
    const result = await ddbDocClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { commentId },
      })
    );
    return result.Item || null;
  },

  async listByPostId(postId) {
    const result = await ddbDocClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: "postId = :pid",
        ExpressionAttributeValues: {
          ":pid": postId,
        },
      })
    );
    const items = result.Items || [];
    return items.sort((a, b) => a.createdAt - b.createdAt);
  }
};
