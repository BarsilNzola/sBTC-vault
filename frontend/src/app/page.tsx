import About from '@/components/About';
import VaultDashboard from '@/components/VaultDashboard';

export default function Home() {
  return (
    <main className="min-h-screen bg-[#131416] text-white">
      <div className="max-w-4xl mx-auto px-4">
        <About />
        <VaultDashboard />
      </div>
    </main>
  );
}
