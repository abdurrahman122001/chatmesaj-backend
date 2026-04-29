import { prisma } from "./src/db.js";
import bcrypt from "bcryptjs";

async function setSuperAdmin() {
  const email = "info@chatmesaj.cc";
  const newPassword = "Admin12345";
  const passwordHash = await bcrypt.hash(newPassword, 10);

  // Check if user exists
  let user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    // Create new user if doesn't exist
    user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name: "Admin",
        role: "SUPERADMIN",
        status: "APPROVED",
        emailVerified: true
      }
    });
    console.log("✓ New SUPERADMIN user created");
  } else {
    // Update existing user
    user = await prisma.user.update({
      where: { email },
      data: { 
        role: "SUPERADMIN", 
        status: "APPROVED",
        emailVerified: true,
        passwordHash
      }
    });
    console.log("✓ Existing user updated to SUPERADMIN");
  }
  
  console.log("Email:", user.email);
  console.log("Password:", newPassword);
  console.log("Role:", user.role);
  console.log("Status:", user.status);
  process.exit(0);
}

setSuperAdmin().catch(e => {
  console.error("Error:", e.message);
  process.exit(1);
});