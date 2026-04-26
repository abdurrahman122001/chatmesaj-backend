import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const email = "info@chatmesaj.cc";
  
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.log("Admin user not found");
    return;
  }

  await prisma.user.update({
    where: { email },
    data: {
      emailVerified: true,
      status: "APPROVED",
    },
  });

  console.log("✓ Admin user updated:");
  console.log("  email:", email);
  console.log("  emailVerified: true");
  console.log("  status: APPROVED");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
