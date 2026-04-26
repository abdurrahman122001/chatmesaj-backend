import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const sites = await prisma.site.findMany();
  console.log("Sites and API keys:");
  for (const site of sites) {
    console.log(`- ${site.name} (ID: ${site.id})`);
    console.log(`  API Key: ${site.apiKey}`);
    console.log(`  User ID: ${site.userId}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
