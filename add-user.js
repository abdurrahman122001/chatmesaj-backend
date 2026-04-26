import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const email = "info@ripcrack.net";
  const password = "Year2021";

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log("User already exists, updating password...");
    await prisma.user.update({
      where: { email },
      data: { passwordHash: await bcrypt.hash(password, 10) }
    });
    console.log("Password updated for:", email);
  } else {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(password, 10),
        name: "Admin",
        role: "ADMIN",
        sites: {
          create: {
            name: "Demo Site",
            apiKey: "demo_" + Math.random().toString(36).slice(2, 10),
            quickActions: { whatsapp: "", email: "", telegram: "" },
          },
        },
      },
      include: { sites: true },
    });
    console.log("User created:", user.email);
    console.log("Site ID:", user.sites[0].id);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
