import { ddbDocClient } from "../config/db.js";
import { PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = "Chats";

export const ChatRepository = {
  async saveMessage(chat) {
    await ddbDocClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: chat,
      })
    );
    return chat;
  },

  async getHistory(room, limit = 50) {
    const result = await ddbDocClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: "room = :room",
        ExpressionAttributeValues: {
          ":room": room,
        },
      })
    );
    const items = result.Items || [];
    return items
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-limit);
  }
};
