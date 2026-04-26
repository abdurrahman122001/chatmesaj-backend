import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.count();
  const sites = await prisma.site.count();
  const conversations = await prisma.conversation.count();
  const knowledge = await prisma.knowledgeEntry.count();
  const contacts = await prisma.contact.count();
  const tickets = await prisma.ticket.count();
  
  console.log("Database counts:");
  console.log(`  Users: ${users}`);
  console.log(`  Sites: ${sites}`);
  console.log(`  Conversations: ${conversations}`);
  console.log(`  Knowledge entries: ${knowledge}`);
  console.log(`  Contacts: ${contacts}`);
  console.log(`  Tickets: ${tickets}`);
  
  // Check all sites
  const allSites = await prisma.site.findMany();
  console.log(`\nAll sites (${allSites.length}):`);
  for (const site of allSites) {
    console.log(`  - ${site.name} (ID: ${site.id}, User ID: ${site.userId})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
