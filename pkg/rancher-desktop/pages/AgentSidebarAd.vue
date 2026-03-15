<template>
  <div
    class="w-full mt-8 bg-[#020202] bg-no-repeat bg-cover bg-right rounded-lg overflow-hidden"
    style="background-image: url('https://outbound.clientbasis.com/assets/media/_head-crop.jpg'); min-width: 400px; height: 300px; margin-left: auto; margin-right: auto;"
  >
    <div class="flex flex-col justify-between h-full p-6">
      <!-- Heading -->
      <div class="mb-6">
        <h3 class="font-bold text-white text-3xl mb-3">
          Book More Appointments
        </h3>
        <span class="font-bold text-white text-lg block mb-4">with Jonathon Byrdziak</span>

        <!-- Items -->
        <div class="flex flex-col gap-2">
          <div class="flex items-center">
            <a
              href="#"
              class="mr-2"
            >
              <svg
                class="w-4 h-4 text-sky-400"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fill-rule="evenodd"
                  d="M3.293 17.707a1 1 0 001.414 0l14-14a1 1 0 010-1.414l-1.414-1.414L11.586 12H9a1 1 0 01-1-1V9.414L3.293 17.707z"
                  clip-rule="evenodd"
                />
                <path d="M5 7a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 01-1 1H6a1 1 0 01-1-1V7z" />
              </svg>
            </a>
            <span class="text-white text-sm">372 building their business</span>
          </div>
          <div class="flex items-center">
            <a
              href="#"
              class="mr-2"
            >
              <svg
                class="w-4 h-4 text-sky-400"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fill-rule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z"
                  clip-rule="evenodd"
                />
              </svg>
            </a>
            <span class="text-white text-sm">on YouTube</span>
          </div>
        </div>
      </div>

      <!-- Action Buttons -->
      <div class="flex gap-3">
        <a
          href="https://www.youtube.com/@ClientBasis"
          target="_blank"
          rel="noopener noreferrer"
          class="flex-1 text-white font-semibold py-2.5 px-4 rounded text-center text-sm transition-colors"
          style="background-color: rgb(255, 111, 30);"
          onmouseover="this.style.backgroundColor='rgb(230, 100, 25)'"
          onmouseout="this.style.backgroundColor='rgb(255, 111, 30)'"
        >
          Watch Now
        </a>
        <a
          href="https://www.skool.com/book-more-appointments-8103/about?ref=9879085d0163482186410063313098b3"
          target="_blank"
          rel="noopener noreferrer"
          class="flex-1 bg-transparent border border-white/30 text-white hover:bg-white/10 font-semibold py-2.5 px-4 rounded text-center text-sm transition-colors"
        >
          Join Community
        </a>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Advertisement component for the sidebar
</script>
