import { motion } from 'framer-motion';
import { TrendingUp } from 'lucide-react';

export default function StatCard({ icon: Icon, label, value, sub, gradient, index = 0, onClick }) {
  const IconComponent = Icon || TrendingUp;
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.07 }}
      onClick={onClick}
      className={`relative overflow-hidden rounded-2xl p-4 text-white shadow-lg ${gradient} ${onClick ? 'cursor-pointer hover:scale-[1.02] transition-transform' : ''}`}
    >
      {/* Background decoration */}
      <div className="absolute -top-4 -right-4 w-20 h-20 bg-white/10 rounded-full" />
      <div className="absolute -bottom-6 -left-6 w-24 h-24 bg-white/5 rounded-full" />

      <div className="relative">
        <div className="flex items-start justify-between mb-3">
          <div className="p-2 bg-white/20 rounded-xl">
            <IconComponent className="w-5 h-5" />
          </div>
        </div>
        <div className="font-grotesk font-bold text-2xl leading-none mb-1">{value}</div>
        <div className="text-white/80 text-sm font-medium">{label}</div>
        {sub && <div className="text-white/60 text-xs mt-1">{sub}</div>}
      </div>
    </motion.div>
  );
}