import { pgPool } from "../config/db.js";

export const UserRepository = {
  async getByEmail(email) {
    const { rows } = await pgPool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (rows.length === 0) return null;
    
    const user = rows[0];
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      password: user.password,
      name: user.name,
      dob: user.dob,
      bio: user.bio,
      profilePhoto: user.profile_photo ? JSON.parse(user.profile_photo) : null,
      role: user.role,
      createdAt: Number(user.created_at),
    };
  },

  async getById(id) {
    const { rows } = await pgPool.query("SELECT * FROM users WHERE id = $1", [id]);
    if (rows.length === 0) return null;

    const user = rows[0];
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      password: user.password,
      name: user.name,
      dob: user.dob,
      bio: user.bio,
      profilePhoto: user.profile_photo ? JSON.parse(user.profile_photo) : null,
      role: user.role,
      createdAt: Number(user.created_at),
    };
  },

  async create(user) {
    await pgPool.query(
      `INSERT INTO users (id, username, email, password, name, dob, bio, profile_photo, role, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        user.id,
        user.username,
        user.email,
        user.password,
        user.name,
        user.dob,
        user.bio || "",
        user.profilePhoto ? JSON.stringify(user.profilePhoto) : null,
        user.role || "student",
        user.createdAt || Date.now(),
      ]
    );
    return user;
  },

  async updateBioAndPhoto(email, bio, profilePhoto) {
    if (profilePhoto) {
      await pgPool.query(
        "UPDATE users SET bio = $1, profile_photo = $2 WHERE email = $3",
        [bio, JSON.stringify(profilePhoto), email]
      );
    } else {
      await pgPool.query("UPDATE users SET bio = $1 WHERE email = $2", [bio, email]);
    }
    return true;
  },

  async listAll() {
    const { rows } = await pgPool.query("SELECT * FROM users ORDER BY username ASC");
    return rows.map((user) => ({
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      dob: user.dob,
      bio: user.bio,
      profilePhoto: user.profile_photo ? JSON.parse(user.profile_photo) : null,
      role: user.role,
      createdAt: Number(user.created_at),
    }));
  }
};
