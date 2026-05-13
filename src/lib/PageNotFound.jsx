import { Link } from 'react-router-dom';
import { Car, Home } from 'lucide-react';

export default function PageNotFound() {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 text-center">
      <div className="w-20 h-20 gradient-primary rounded-3xl flex items-center justify-center mb-6 shadow-2xl">
        <Car className="w-10 h-10 text-white" />
      </div>
      <h1 className="text-4xl font-grotesk font-bold mb-2">404</h1>
      <p className="text-muted-foreground mb-8">This road leads nowhere.</p>
      <Link
        to="/"
        className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-blue-500 to-indigo-600 text-white rounded-2xl font-semibold shadow-lg hover:opacity-90 transition-opacity"
      >
        <Home className="w-4 h-4" />
        Back to Dashboard
      </Link>
    </div>
  );
}