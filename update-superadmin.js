import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Change superadmin email
  const user = await prisma.user.findFirst({
    where: { email: 'info@ripcrack.net' }
  });
  if (user) {
    await prisma.user.update({
      where: { id: user.id },
      data: { email: 'info@chatmesaj.cc' }
    });
    console.log("Superadmin email updated to: info@chatmesaj.cc");
  } else {
    console.log("No superadmin found with info@ripcrack.net");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
