import { pgTable, serial, text, timestamp, integer, boolean, numeric } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  inviteCode: text("invite_code").notNull().unique(),
  partnerId: integer("partner_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const items = pgTable("items", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  url: text("url"),
  price: numeric("price"),
  priority: integer("priority").notNull().default(2),
  notes: text("notes"),
  image: text("image"),
  reserved: boolean("reserved").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
