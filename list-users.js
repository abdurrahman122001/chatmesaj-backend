import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    include: { sites: true }
  });
  
  console.log("All users:");
  for (const user of users) {
    console.log(`- ID: ${user.id}, Email: ${user.email}, Name: ${user.name}, Sites: ${user.sites.length}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
