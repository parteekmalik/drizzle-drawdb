import { pgTable, serial, pgEnum, text, timestamp, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";

export const role = pgEnum("role", ["admin", "user", "guest"]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  role: role("role").notNull().default("user"),
});

export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  authorId: serial("author_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  titleIdx: index("posts_title_idx").on(t.title),
  emailUnique: uniqueIndex("users_email_uniq").on(t.title),
}));

export const memberships = pgTable("memberships", {
  userId: serial("user_id").notNull(),
  teamId: serial("team_id").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.teamId] }),
}));
